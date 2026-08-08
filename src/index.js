// Backend — relais IA avec mémoire persistante (Cloudflare KV).
// Le client (app) envoie son profil local (notes/refs/fichiers) à CHAQUE appel ;
// ce worker le fusionne avec une mémoire côté serveur (KV) qui survit entre les
// sessions et les appareils, plutôt que de tout redemander au client à chaque fois.
//
// ⚠️ Ce fichier fait partie d'un projet npm (voir package.json / wrangler.toml)
// déployé automatiquement via GitHub Actions — il ne se colle plus dans le
// "Quick edit" du dashboard Cloudflare (à cause de la dépendance "pawnote"
// pour Pronote, qui nécessite un vrai build).
//
// CONFIGURATION REQUISE (Settings > Variables and Secrets du worker, déjà en
// place si tu as suivi les étapes précédentes) :
//  1. Secret texte : MISTRAL_API_KEY
//  2. Secrets : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
//  3. KV Namespace binding "MEMORY" + D1 binding "DB" (déclarés dans wrangler.toml)

import * as pronote from "pawnote";

const MEMORY_PROFILE_KEY = "p5tm:profile";
const MEMORY_CHAT_KEY = "p5tm:chat";
const MAX_CHAT_HISTORY = 40; // messages conservés en mémoire (user + assistant confondus)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/health") {
      return new Response("ok", { headers: corsHeaders() });
    }

    if (url.pathname === "/ai/suggest" && request.method === "POST") {
      return handleSuggest(request, env);
    }

    if (url.pathname === "/ai/chat" && request.method === "POST") {
      return handleChat(request, env);
    }

    if (url.pathname === "/icloud/sync" && request.method === "POST") {
      return handleIcloudSync(request);
    }

    if (url.pathname === "/pronote/sync" && request.method === "POST") {
      return handlePronoteSync(request);
    }

    if (url.pathname === "/state/push" && request.method === "POST") {
      return handleStatePush(request, env);
    }
    if (url.pathname === "/state/get" && request.method === "GET") {
      return handleStateGet(env);
    }
    if (url.pathname === "/notif/log" && request.method === "GET") {
      return handleNotifLog(env);
    }

    if (url.pathname === "/push/subscribe" && request.method === "POST") {
      return handlePushSubscribe(request, env);
    }
    if (url.pathname === "/push/test" && request.method === "POST") {
      return handlePushTest(env);
    }

    // Voir / effacer la mémoire côté serveur (debug, ou futur bouton dans l'app)
    if (url.pathname === "/ai/memory" && request.method === "GET") {
      return handleMemoryGet(env);
    }
    if (url.pathname === "/ai/memory" && request.method === "DELETE") {
      return handleMemoryClear(env);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },

  // Déclenché par le Cron Trigger configuré dans le dashboard (Worker > Triggers).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDeadlineCheck(env));
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

/* ----------------------- Mémoire (KV) ----------------------- */

async function kvGetJSON(env, key, fallback) {
  if (!env.MEMORY) return fallback; // pas de binding KV configuré -> mode stateless
  try {
    const raw = await env.MEMORY.get(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function kvPutJSON(env, key, value) {
  if (!env.MEMORY) return; // pas de binding KV -> on n'essaie pas de sauvegarder
  try {
    await env.MEMORY.put(key, JSON.stringify(value));
  } catch {
    // on n'échoue jamais la requête à cause d'un souci de sauvegarde mémoire
  }
}

function emptyProfile() {
  return { notes: [], refs: [], files: [] };
}

// Fusionne le profil envoyé par le client avec celui déjà en mémoire côté serveur.
// Le serveur garde tout ce qu'il a déjà vu, même si le client ne le renvoie plus
// (ex : note ajoutée depuis un autre appareil, ou localStorage vidé sur ce device).
function mergeProfile(persisted, incoming) {
  const merged = {
    notes: Array.isArray(persisted.notes) ? [...persisted.notes] : [],
    refs: Array.isArray(persisted.refs) ? [...persisted.refs] : [],
    files: Array.isArray(persisted.files) ? [...persisted.files] : [],
  };

  (incoming?.notes || []).forEach((n) => {
    if (typeof n === "string" && n.trim() && !merged.notes.includes(n)) merged.notes.push(n);
  });

  (incoming?.refs || []).forEach((r) => {
    if (!r || !r.title) return;
    const exists = merged.refs.some((x) => x.title === r.title && x.url === r.url);
    if (!exists) merged.refs.push({ title: r.title, url: r.url || "" });
  });

  (incoming?.files || []).forEach((f) => {
    if (!f || !f.name) return;
    const idx = merged.files.findIndex((x) => x.name === f.name);
    if (idx >= 0) merged.files[idx] = { name: f.name, text: f.text || "" }; // dernière version gagne
    else merged.files.push({ name: f.name, text: f.text || "" });
  });

  return merged;
}

async function loadAndMergeProfile(env, incomingProfile) {
  const persisted = await kvGetJSON(env, MEMORY_PROFILE_KEY, emptyProfile());
  const merged = mergeProfile(persisted, incomingProfile || {});
  await kvPutJSON(env, MEMORY_PROFILE_KEY, merged);
  return merged;
}

async function handleMemoryGet(env) {
  const profile = await kvGetJSON(env, MEMORY_PROFILE_KEY, emptyProfile());
  const chat = await kvGetJSON(env, MEMORY_CHAT_KEY, []);
  return Response.json({ profile, chat, hasMemoryBinding: !!env.MEMORY }, { headers: corsHeaders() });
}

async function handleMemoryClear(env) {
  await kvPutJSON(env, MEMORY_PROFILE_KEY, emptyProfile());
  await kvPutJSON(env, MEMORY_CHAT_KEY, []);
  return Response.json({ cleared: true }, { headers: corsHeaders() });
}

/* ----------------------- Appel Mistral ----------------------- */

// API Conversations de Mistral (nécessaire pour le tool web_search — l'API
// Chat Completions classique ne le supporte pas).
async function callMistral(env, { instructions, inputs }) {
  const res = await fetch("https://api.mistral.ai/v1/conversations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: "mistral-medium-latest",
      instructions: instructions.join(" "),
      inputs,
      tools: [{ type: "web_search" }],
    }),
  });

  const data = await res.json();
  // ⚠️ Le format exact de la réponse (outputs[].content en liste de chunks
  // {type, text}) est basé sur la doc Mistral au moment d'écrire ce fichier —
  // à vérifier avec un vrai appel, et ajuster ce parsing si la structure diffère.
  const message = data.outputs?.find((o) => o.type === "message.output");
  const textChunk = message?.content?.find?.((c) => c.type === "text") ?? message?.content;
  const text = typeof textChunk === "string" ? textChunk : (textChunk?.text ?? "");
  return text;
}

function profileToPrompt(profile) {
  const parts = [];
  if (profile.notes?.length) {
    parts.push("Centres d'intérêt / notes de l'utilisateur :\n- " + profile.notes.join("\n- "));
  }
  if (profile.refs?.length) {
    parts.push(
      "Références qu'il apprécie :\n" +
        profile.refs.map((r) => "- " + r.title + (r.url ? " (" + r.url + ")" : "")).join("\n")
    );
  }
  if (profile.files?.length) {
    parts.push(
      profile.files
        .map((f) => "Fichier joint « " + f.name + " » :\n" + f.text.slice(0, 4000))
        .join("\n\n")
    );
  }
  return parts.join("\n\n") || "Aucune information de profil disponible pour l'instant.";
}

/* ----------------------- /ai/suggest ----------------------- */

async function handleSuggest(request, env) {
  const body = await request.json();
  const slot = body.slot || {};
  const profile = await loadAndMergeProfile(env, body.profile);

  const instructions = [
    "Tu proposes 2 à 3 activités concrètes pour un créneau de temps libre dans une app de gestion du temps",
    "façon Persona 5 (stats : savoir, audace, bienveillance, habilete, charme).",
    "Base-toi sur le profil utilisateur fourni (notes, références, fichiers) pour des suggestions personnalisées",
    "et pertinentes (ex: proposer une vidéo dans un domaine qu'il aime plutôt qu'une suggestion générique).",
    "Utilise web_search uniquement si une suggestion (vidéo, actu, lecture) bénéficie vraiment d'une info à jour.",
    "Réponds UNIQUEMENT avec un JSON strict de la forme :",
    '{"suggestions":[{"title":"...","stat":"savoir|audace|bienveillance|habilete|charme","amt":1,"sub":"courte raison"}]}',
    "amt doit rester petit (1 à 2). Pas de texte hors du JSON.",
  ];

  const inputs = [
    {
      role: "user",
      content:
        "Créneau : " + JSON.stringify(slot) + "\n\nProfil utilisateur :\n" + profileToPrompt(profile),
    },
  ];

  let suggestions = [];
  try {
    const text = await callMistral(env, { instructions, inputs });
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  } catch (err) {
    return Response.json({ suggestions: [], parseError: true, error: String(err) }, { headers: corsHeaders() });
  }

  return Response.json({ suggestions }, { headers: corsHeaders() });
}

/* ----------------------- /ai/chat ----------------------- */

async function handleChat(request, env) {
  const body = await request.json();
  const userMessage = String(body.message || "").trim();
  const profile = await loadAndMergeProfile(env, body.profile);

  // Historique persistant côté serveur ; si vide (première fois), on part de
  // l'historique envoyé par le client pour ne rien perdre.
  let history = await kvGetJSON(env, MEMORY_CHAT_KEY, []);
  if (!history.length && Array.isArray(body.history)) {
    history = body.history.map((m) => ({ role: m.role, content: m.content }));
  }

  history.push({ role: "user", content: userMessage });

  const instructions = [
    "Tu es l'assistant IA d'une app de gestion du temps façon Persona 5.",
    "Tu discutes directement avec l'utilisateur : réponds de façon naturelle, concise et utile.",
    "Tiens compte de son profil (notes, références, fichiers joints) donné ci-dessous pour personnaliser tes réponses.",
    "Utilise web_search si une question porte sur une info récente ou factuelle qui le justifie.",
    "Réponds en texte simple (pas de JSON ici).",
  ];

  const inputs = [
    { role: "user", content: "Profil utilisateur :\n" + profileToPrompt(profile) },
    ...history,
  ];

  let reply;
  try {
    const text = await callMistral(env, { instructions, inputs });
    reply = text.trim() || "…";
  } catch (err) {
    return Response.json({ reply: null, error: String(err) }, { status: 500, headers: corsHeaders() });
  }

  history.push({ role: "assistant", content: reply });
  if (history.length > MAX_CHAT_HISTORY) history = history.slice(-MAX_CHAT_HISTORY);
  await kvPutJSON(env, MEMORY_CHAT_KEY, history);

  return Response.json({ reply }, { headers: corsHeaders() });
}

/* ======================================================================
   Sync iCloud (CalDAV) — client minimal en JS pur, sans librairie externe.
   ⚠️ Apple exige un "mot de passe spécifique à l'application" (pas le vrai
   mot de passe Apple ID) : appleid.apple.com > Sécurité > Mots de passe
   pour applications.
   ⚠️ Les créneaux de l'app sont hebdomadaires récurrents (jour de semaine +
   heure), pas datés. On récupère donc les événements de la semaine en cours
   (lundi -> dimanche) et on les convertit en jour-de-semaine (0=lundi..6=dimanche).
   ⚠️ Fuseau horaire supposé Europe/Paris (calcul CET/CEST simplifié) pour les
   événements en UTC ("Z"). Les événements avec une heure "flottante" (sans Z
   ni TZID) sont pris tels quels comme heure locale.
   ====================================================================== */

const ICLOUD_CALDAV_ROOT = "https://caldav.icloud.com/";

async function handleIcloudSync(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ events: [], error: "JSON invalide" }, { status: 400, headers: corsHeaders() });
  }

  const email = String(body.email || "").trim();
  const password = String(body.password || "").trim();
  if (!email || !password) {
    return Response.json({ events: [], error: "email/mot de passe manquant" }, { status: 400, headers: corsHeaders() });
  }

  const authHeader = "Basic " + btoa(email + ":" + password);

  try {
    const principalHref = await davDiscoverPrincipal(authHeader);
    const calendarHomeHref = await davDiscoverCalendarHome(authHeader, principalHref);
    const calendars = await davListCalendars(authHeader, calendarHomeHref);

    const { startUtc, endUtc } = currentWeekRangeUtc();
    let allEvents = [];

    // On limite à 5 calendriers pour rester raisonnable (temps de réponse / quota).
    for (const cal of calendars.slice(0, 5)) {
      const icsBlocks = await davCalendarQuery(authHeader, cal.href, startUtc, endUtc);
      icsBlocks.forEach((ics) => {
        allEvents = allEvents.concat(parseIcsEvents(ics));
      });
    }

    const events = allEvents
      .map((ev) => icsEventToAppSlot(ev))
      .filter(Boolean);

    return Response.json({ events }, { headers: corsHeaders() });
  } catch (err) {
    return Response.json({ events: [], error: String(err && err.message ? err.message : err) }, { status: 502, headers: corsHeaders() });
  }
}

async function davRequest(authHeader, url, method, extraHeaders, xmlBody) {
  const res = await fetch(url, {
    method,
    headers: Object.assign(
      {
        Authorization: authHeader,
        "Content-Type": "application/xml; charset=utf-8",
      },
      extraHeaders || {}
    ),
    body: xmlBody,
  });
  const text = await res.text();
  if (res.status >= 400) {
    throw new Error("CalDAV " + method + " " + url + " -> HTTP " + res.status);
  }
  return text;
}

// Retire les préfixes de namespace XML (D:, dav:, cal:, C:, ...) pour simplifier
// le parsing par regex, quel que soit le préfixe utilisé par le serveur.
function stripXmlNamespaces(xml) {
  return xml.replace(/<(\/?)[A-Za-z0-9]+:/g, "<$1");
}

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractFirstTagContent(xml, tagName) {
  const m = xml.match(new RegExp("<" + tagName + "[^>]*>([\\s\\S]*?)</" + tagName + ">", "i"));
  return m ? m[1].trim() : null;
}

function extractAllBlocks(xml, tagName) {
  const regex = new RegExp("<" + tagName + "[^>]*>([\\s\\S]*?)</" + tagName + ">", "gi");
  const out = [];
  let m;
  while ((m = regex.exec(xml)) !== null) out.push(m[0]);
  return out;
}

/* ======================================================================
   Sync Pronote — via la librairie npm "pawnote" (pas d'API officielle,
   projet tiers activement maintenu, utilisé par l'appli Papillon).
   ✅ Noms de fonctions/champs vérifiés directement dans le .d.ts publié du
   paquet pawnote@1.6.2 (dist/index.d.ts, téléchargé et inspecté) :
     - Récupération du planning : `timetableFromIntervals(session, startDate, endDate)`
       (et non `getTimetableFromDate`, qui n'existe pas dans cette version).
     - `parseTimetable(session, timetable, options)` ne retourne rien (void) :
       elle filtre `timetable.classes` en place. Il faut lire `timetable.classes`
       après l'appel, pas récupérer une valeur de retour.
     - `timetable.classes` mélange des entrées "lesson"/"activity"/"detention"
       (champ discriminant `is`) ; seules les "lesson" ont `subject`/`canceled`.
     - Sur une "lesson" : `startDate`/`endDate` sont déjà des objets Date (pas
       des chaînes `from`/`to`), `canceled` est un booléen, `subject` est
       `{ id, name, inGroups }` ou `undefined`.
   Cela dit, cette partie reste NON testée avec un vrai compte Pronote (seule
   la signature de l'API a pu être vérifiée hors-ligne, pas le comportement
   réel du serveur Pronote). Si `/pronote/sync` échoue encore, l'erreur vient
   plus probablement des identifiants/de l'URL d'établissement ou d'un cas
   particulier du serveur Pronote que d'un nom de fonction incorrect.
   ⚠️ Il faut l'URL Pronote spécifique à l'établissement (visible dans la
   barre d'adresse quand on se connecte sur pronote.index-education.net,
   ou dans l'app Pronote > Partager/QR code) — pas juste l'identifiant.
   ⚠️ deviceUUID recalculé de façon stable (hash de l'identifiant) à chaque
   appel plutôt que persisté en base : si Pronote redemande une validation
   d'appareil à chaque connexion, il faudra le stocker en D1 comme pour
   push_subscriptions.
   ====================================================================== */

async function handlePronoteSync(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ events: [], error: "JSON invalide" }, { status: 400, headers: corsHeaders() });
  }

  const pronoteUrl = String(body.url || "").trim();
  const username = String(body.username || "").trim();
  const password = String(body.password || "").trim();
  if (!pronoteUrl || !username || !password) {
    return Response.json({ events: [], error: "url/identifiant/mot de passe manquant" }, { status: 400, headers: corsHeaders() });
  }

  try {
    const session = pronote.createSessionHandle();
    const deviceUUID = await stableDeviceUUID(username);

    await pronote.loginCredentials(session, {
      url: pronoteUrl,
      deviceUUID,
      kind: pronote.AccountKind.STUDENT,
      username,
      password,
    });

    const { startDate, endDate } = currentWeekDatesLocal();

    // Vérifié directement dans le .d.ts publié du paquet "pawnote" 1.6.2 :
    // - la fonction s'appelle `timetableFromIntervals` (pas `getTimetableFromDate`)
    //   et prend directement (session, startDate, endDate).
    // - `parseTimetable` ne RETOURNE rien (void) : elle filtre `timetable.classes`
    //   EN PLACE selon les options. Il faut donc lire `timetable.classes` après coup,
    //   pas récupérer une valeur de retour.
    const timetable = await pronote.timetableFromIntervals(session, startDate, endDate);
    pronote.parseTimetable(session, timetable, {
      withCanceledClasses: false,
      withPlannedClasses: true,
      withSuperposedCanceledClasses: false,
    });

    // `timetable.classes` mélange cours ("lesson"), activités ("activity") et
    // colles ("detention") — on ne garde que les cours pour le planning.
    const events = (timetable.classes || [])
      .filter((c) => c.is === "lesson")
      .map((lesson) => pronoteLessonToAppSlot(lesson))
      .filter(Boolean);

    return Response.json({ events }, { headers: corsHeaders() });
  } catch (err) {
    return Response.json({ events: [], error: String(err && err.message ? err.message : err) }, { status: 502, headers: corsHeaders() });
  }
}

async function stableDeviceUUID(seed) {
  const bytes = new TextEncoder().encode("p5tm-pronote-" + seed);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
}

function currentWeekDatesLocal() {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 0=lundi
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  return { startDate: monday, endDate: sunday };
}

// Champs confirmés dans le .d.ts de pawnote 1.6.2 (type TimetableClassLesson) :
// startDate/endDate sont déjà des objets Date (pas des chaînes), canceled est
// un booléen, subject est { id, name, inGroups } | undefined.
function pronoteLessonToAppSlot(lesson) {
  if (!lesson || !lesson.startDate) return null;
  if (lesson.canceled) return null;

  const start = new Date(lesson.startDate);
  const end = lesson.endDate ? new Date(lesson.endDate) : start;
  const dow = (start.getDay() + 6) % 7;
  const title = (lesson.subject && lesson.subject.name) || "Cours Pronote";

  return {
    externalId: String(lesson.id || (title + "-" + start.toISOString())),
    title,
    day: String(dow),
    start: pad2(start.getHours()) + ":" + pad2(start.getMinutes()),
    end: pad2(end.getHours()) + ":" + pad2(end.getMinutes()),
    cat: "savoir",
  };
}

async function davDiscoverPrincipal(authHeader) {
  const xmlBody =
    '<?xml version="1.0" encoding="utf-8" ?>' +
    '<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>';
  const res = await davRequest(authHeader, ICLOUD_CALDAV_ROOT, "PROPFIND", { Depth: "0" }, xmlBody);
  const clean = stripXmlNamespaces(res);
  const principalBlock = extractFirstTagContent(clean, "current-user-principal");
  const href = principalBlock ? extractFirstTagContent(principalBlock, "href") : null;
  if (!href) throw new Error("Impossible de trouver le principal iCloud (identifiants invalides ?)");
  return new URL(href, ICLOUD_CALDAV_ROOT).toString();
}

async function davDiscoverCalendarHome(authHeader, principalUrl) {
  const xmlBody =
    '<?xml version="1.0" encoding="utf-8" ?>' +
    '<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    "<prop><C:calendar-home-set/></prop></propfind>";
  const res = await davRequest(authHeader, principalUrl, "PROPFIND", { Depth: "0" }, xmlBody);
  const clean = stripXmlNamespaces(res);
  const block = extractFirstTagContent(clean, "calendar-home-set");
  const href = block ? extractFirstTagContent(block, "href") : null;
  if (!href) throw new Error("Impossible de trouver le calendar-home-set iCloud");
  return new URL(href, ICLOUD_CALDAV_ROOT).toString();
}

async function davListCalendars(authHeader, calendarHomeUrl) {
  const xmlBody =
    '<?xml version="1.0" encoding="utf-8" ?>' +
    '<propfind xmlns="DAV:"><prop><resourcetype/><displayname/></prop></propfind>';
  const res = await davRequest(authHeader, calendarHomeUrl, "PROPFIND", { Depth: "1" }, xmlBody);
  const clean = stripXmlNamespaces(res);
  const responses = extractAllBlocks(clean, "response");

  const calendars = [];
  responses.forEach((block) => {
    const resourcetype = extractFirstTagContent(block, "resourcetype") || "";
    if (!/calendar/i.test(resourcetype)) return;
    const href = extractFirstTagContent(block, "href");
    if (!href) return;
    const displayname = extractFirstTagContent(block, "displayname") || "";
    calendars.push({ href: new URL(href, calendarHomeUrl).toString(), displayname });
  });
  return calendars;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function formatCalDavUtc(date) {
  return (
    date.getUTCFullYear() +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    "T" +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    "Z"
  );
}

// Lundi 00:00 -> dimanche 23:59:59 de la semaine en cours (approx. Europe/Paris,
// simplifié : on utilise l'heure UTC du serveur, +/- quelques heures ne changent
// pas le résultat pour "cette semaine").
function currentWeekRangeUtc() {
  const now = new Date();
  const dow = (now.getUTCDay() + 6) % 7; // 0=lundi
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow, 0, 0, 0));
  const nextMonday = new Date(monday.getTime() + 7 * 86400000);
  return { startUtc: formatCalDavUtc(monday), endUtc: formatCalDavUtc(nextMonday) };
}

async function davCalendarQuery(authHeader, calendarUrl, startUtc, endUtc) {
  const xmlBody =
    '<?xml version="1.0" encoding="utf-8" ?>' +
    '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' +
    "<D:prop><D:getetag/><C:calendar-data/></D:prop>" +
    '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">' +
    '<C:time-range start="' + startUtc + '" end="' + endUtc + '"/>' +
    "</C:comp-filter></C:comp-filter></C:filter>" +
    "</C:calendar-query>";
  const res = await davRequest(authHeader, calendarUrl, "REPORT", { Depth: "1" }, xmlBody);
  const clean = stripXmlNamespaces(res);
  const responses = extractAllBlocks(clean, "response");
  return responses
    .map((block) => extractFirstTagContent(block, "calendar-data"))
    .filter(Boolean)
    .map((raw) => decodeXmlEntities(raw));
}

// Parse un flux iCal (VCALENDAR) et retourne les VEVENT bruts { uid, summary, dtstart, dtend }
function parseIcsEvents(icsText) {
  const events = [];
  const blocks = icsText.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  blocks.forEach((block) => {
    const uid = icsField(block, "UID");
    const summary = icsField(block, "SUMMARY");
    const dtstart = icsFieldWithParams(block, "DTSTART");
    const dtend = icsFieldWithParams(block, "DTEND");
    if (uid && summary && dtstart) {
      events.push({ uid, summary: unescapeIcsText(summary), dtstart, dtend });
    }
  });
  return events;
}

function icsField(block, name) {
  const m = block.match(new RegExp("^" + name + "(?:;[^:\\r\\n]*)?:(.*)$", "m"));
  return m ? m[1].trim() : null;
}

// Retourne { value, isUtc, isDateOnly } pour un champ type DTSTART/DTEND
// (gère DTSTART:20260805T180000Z, DTSTART;TZID=Europe/Paris:20260805T180000,
// et DTSTART;VALUE=DATE:20260805 pour les événements "journée entière").
function icsFieldWithParams(block, name) {
  const m = block.match(new RegExp("^" + name + "(;[^:\\r\\n]*)?:([0-9TzZ]+)$", "m"));
  if (!m) return null;
  const params = m[1] || "";
  const value = m[2];
  return {
    value,
    isUtc: value.endsWith("Z"),
    isDateOnly: /VALUE=DATE\b/i.test(params) && value.length === 8,
  };
}

function unescapeIcsText(text) {
  return text.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ").replace(/\\\\/g, "\\");
}

// Décalage Europe/Paris approximatif (CET=+1 / CEST=+2), règle simplifiée :
// heure d'été du dernier dimanche de mars au dernier dimanche d'octobre.
function parisOffsetHours(dateUtc) {
  const year = dateUtc.getUTCFullYear();
  const lastSunday = (month) => {
    const d = new Date(Date.UTC(year, month + 1, 0, 1, 0, 0)); // fin de mois
    const back = d.getUTCDay(); // 0=dimanche
    d.setUTCDate(d.getUTCDate() - back);
    return d;
  };
  const dstStart = lastSunday(2); // mars
  const dstEnd = lastSunday(9); // octobre
  return dateUtc >= dstStart && dateUtc < dstEnd ? 2 : 1;
}

function icsDateToPartsLocal(field) {
  const v = field.value;
  const y = Number(v.slice(0, 4));
  const mo = Number(v.slice(4, 6)) - 1;
  const d = Number(v.slice(6, 8));
  if (field.isDateOnly) {
    return { year: y, month: mo, date: d, hour: 0, minute: 0 };
  }
  const h = Number(v.slice(9, 11));
  const mi = Number(v.slice(11, 13));
  if (field.isUtc) {
    const utcDate = new Date(Date.UTC(y, mo, d, h, mi, 0));
    const offset = parisOffsetHours(utcDate);
    const local = new Date(utcDate.getTime() + offset * 3600000);
    return { year: local.getUTCFullYear(), month: local.getUTCMonth(), date: local.getUTCDate(), hour: local.getUTCHours(), minute: local.getUTCMinutes() };
  }
  // Pas de "Z" (heure flottante ou TZID donné) : on prend les chiffres tels quels.
  return { year: y, month: mo, date: d, hour: h, minute: mi };
}

// Convertit un VEVENT en créneau au format attendu par l'app (jour de semaine 0-6, HH:MM).
function icsEventToAppSlot(ev) {
  if (!ev.dtstart) return null;
  const start = icsDateToPartsLocal(ev.dtstart);
  const startJsDate = new Date(Date.UTC(start.year, start.month, start.date));
  const dow = (startJsDate.getUTCDay() + 6) % 7; // 0=lundi

  let endHour = start.hour, endMinute = start.minute;
  if (ev.dtend) {
    const end = icsDateToPartsLocal(ev.dtend);
    endHour = end.hour;
    endMinute = end.minute;
  }

  return {
    externalId: ev.uid,
    title: ev.summary,
    day: String(dow),
    start: pad2(start.hour) + ":" + pad2(start.minute),
    end: pad2(endHour) + ":" + pad2(endMinute),
    cat: "",
  };
}

/* ======================================================================
   État persistant côté serveur (D1) + vérification automatique périodique.
   ⚠️ Nécessite un binding D1 nommé "DB" (Settings > Bindings > Add > D1
   Database, variable name "DB", base "p5tm-db").
   ⚠️ Usage mono-utilisateur simple : une seule ligne d'état ("default").
   Suffisant pour un usage perso ; à faire évoluer si multi-appareils avec
   comptes séparés un jour.
   ⚠️ Le Cron Trigger (ex: "toutes les 15 min") se configure dans le
   dashboard : Worker > Triggers > Cron Triggers > Add Cron Trigger — pas de
   binding à créer pour ça, juste ajouter l'event (expression cron standard,
   ex. une exécution toutes les 15 minutes).
   ⚠️ Pour l'instant le Cron ne fait QUE calculer et journaliser (table
   notif_log) les échéances proches / confidents en retard — il n'envoie pas
   encore de vraie notification push (ça demande service worker + VAPID,
   étape suivante à part).
   ====================================================================== */

async function ensureSchema(env) {
  if (!env.DB) return;
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS app_state (id TEXT PRIMARY KEY, data TEXT, updated_at TEXT)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS notif_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, message TEXT)"
    ),
  ]);
}

async function handleStatePush(request, env) {
  if (!env.DB) {
    return Response.json({ ok: false, error: "D1 non lié (binding DB manquant)" }, { status: 501, headers: corsHeaders() });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "JSON invalide" }, { status: 400, headers: corsHeaders() });
  }
  await ensureSchema(env);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO app_state (id, data, updated_at) VALUES ('default', ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at"
  )
    .bind(JSON.stringify(body), now)
    .run();
  return Response.json({ ok: true, updated_at: now }, { headers: corsHeaders() });
}

async function handleStateGet(env) {
  if (!env.DB) {
    return Response.json({ ok: false, error: "D1 non lié (binding DB manquant)" }, { status: 501, headers: corsHeaders() });
  }
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT data, updated_at FROM app_state WHERE id='default'").first();
  if (!row) return Response.json({ ok: true, data: null, updated_at: null }, { headers: corsHeaders() });
  return Response.json({ ok: true, data: JSON.parse(row.data), updated_at: row.updated_at }, { headers: corsHeaders() });
}

// Calcule les échéances proches et confidents en retard à partir de l'état
// sauvegardé, et journalise le résultat dans notif_log (pas d'envoi réel
// pour l'instant — voir note en haut du bloc).
async function runDeadlineCheck(env) {
  if (!env.DB) return;
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT data FROM app_state WHERE id='default'").first();
  if (!row) return;

  let state;
  try {
    state = JSON.parse(row.data);
  } catch {
    return;
  }

  const messages = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  (state.slots || []).forEach((slot) => {
    if (!slot.isDeadline || !slot.deadlineDate) return;
    const dl = new Date(slot.deadlineDate);
    const daysLeft = Math.round((dl - today) / 86400000);
    const window = Number(slot.anticipationDays) || 3;
    if (daysLeft >= 0 && daysLeft <= window) {
      messages.push("Échéance « " + slot.title + " » dans " + daysLeft + " jour(s)");
    }
  });

  (state.confidants || []).forEach((c) => {
    if (!c.lastContact || !c.targetFrequency) return;
    const last = new Date(c.lastContact);
    const daysSince = Math.round((today - last) / 86400000);
    if (daysSince >= Number(c.targetFrequency)) {
      messages.push("Ça fait " + daysSince + " jours sans contacter " + c.name);
    }
  });

  if (messages.length) {
    await env.DB.prepare("INSERT INTO notif_log (created_at, message) VALUES (?, ?)")
      .bind(new Date().toISOString(), messages.join(" | "))
      .run();

    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
      const subs = await getAllPushSubscriptions(env);
      for (const sub of subs) {
        try {
          await sendWebPush(env, sub, { title: "Persona5 Time Manager", body: messages.join(" | ") });
        } catch (err) {
          // échec sur un abonnement (ex: expiré) -> on continue avec les autres, pas de log ici
          // pour rester simple ; à surveiller via /push/test si des notifs manquent.
        }
      }
    }
  }
}

async function handleNotifLog(env) {
  if (!env.DB) {
    return Response.json({ ok: false, error: "D1 non lié (binding DB manquant)" }, { status: 501, headers: corsHeaders() });
  }
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    "SELECT id, created_at, message FROM notif_log ORDER BY id DESC LIMIT 50"
  ).all();
  return Response.json({ ok: true, logs: results }, { headers: corsHeaders() });
}

/* ======================================================================
   Notifications push réelles (Web Push standard — RFC 8291/8292), en JS pur
   via WebCrypto (crypto.subtle), sans librairie externe.
   ⚠️ CONFIGURATION REQUISE (Settings > Variables and Secrets) :
      - Secret VAPID_PUBLIC_KEY  = clé publique VAPID (voir message à côté)
      - Secret VAPID_PRIVATE_KEY = clé privée VAPID (voir message à côté)
      - Binding D1 "DB" (déjà en place si tu as suivi l'étape précédente)
   ⚠️ Le chiffrement du contenu (aes128gcm) suit le RFC 8291 à la lettre,
   mais n'a pas pu être testé en conditions réelles ici (pas d'environnement
   Workers disponible pour émettre un vrai push). À valider avec un vrai
   abonnement au premier essai — utilise /push/test pour ça.
   ====================================================================== */

function base64UrlToBytes(str) {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  arrays.forEach((a) => {
    out.set(a, offset);
    offset += a.length;
  });
  return out;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function importVapidPrivateKey(env) {
  const pub = base64UrlToBytes(env.VAPID_PUBLIC_KEY); // 65 octets : 0x04 || X(32) || Y(32)
  const priv = base64UrlToBytes(env.VAPID_PRIVATE_KEY); // 32 octets
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(pub.slice(1, 33)),
    y: bytesToBase64Url(pub.slice(33, 65)),
    d: bytesToBase64Url(priv),
    ext: true,
    key_ops: ["sign"],
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

function base64UrlJson(obj) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

// JWT VAPID (RFC 8292) : identifie le serveur auprès du service de push (Apple/Google/Mozilla...).
async function buildVapidAuthHeader(env, endpoint) {
  const audience = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:contact@persona5-time-manager.app" };
  const unsigned = base64UrlJson(header) + "." + base64UrlJson(payload);
  const key = await importVapidPrivateKey(env);
  // Web Crypto renvoie la signature ECDSA au format brut r||s (64 octets pour P-256),
  // exactement ce qu'attend un JWT ES256 (pas de ré-encodage DER nécessaire).
  const sigBuf = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + "." + bytesToBase64Url(new Uint8Array(sigBuf));
  return "vapid t=" + jwt + ", k=" + env.VAPID_PUBLIC_KEY;
}

// Chiffrement du contenu au format aes128gcm (RFC 8291 + RFC 8188).
async function encryptWebPushPayload(subscription, payloadObj) {
  const plaintext = new TextEncoder().encode(JSON.stringify(payloadObj));

  const uaPublicBytes = base64UrlToBytes(subscription.keys.p256dh); // clé publique du navigateur (65 octets)
  const authSecret = base64UrlToBytes(subscription.keys.auth); // secret d'abonnement (16 octets)

  // Paire de clés ECDH éphémère côté serveur ("as" = application server)
  const asKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", asKeyPair.publicKey));

  const uaPublicKey = await crypto.subtle.importKey("raw", uaPublicBytes, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, asKeyPair.privateKey, 256)
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Étape spécifique Web Push : combine auth_secret + secret ECDH -> IKM
  const authInfo = concatBytes(new TextEncoder().encode("WebPush: info\0"), uaPublicBytes, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdhSecret, authInfo, 32);

  // Dérivation standard aes128gcm (RFC 8188) à partir du salt + IKM
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);

  const record = concatBytes(plaintext, new Uint8Array([2])); // 2 = délimiteur "dernier enregistrement"
  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, record));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096); // taille d'enregistrement (un seul enregistrement ici)

  const header = concatBytes(salt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw);
  return concatBytes(header, ciphertext);
}

async function sendWebPush(env, subscription, payloadObj) {
  const body = await encryptWebPushPayload(subscription, payloadObj);
  const authHeader = await buildVapidAuthHeader(env, subscription.endpoint);
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "86400",
      Authorization: authHeader,
    },
    body,
  });
}

/* --- Stockage des abonnements (D1) --- */

async function ensurePushSchema(env) {
  if (!env.DB) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, created_at TEXT)"
  ).run();
}

async function handlePushSubscribe(request, env) {
  if (!env.DB) return Response.json({ ok: false, error: "D1 non lié (binding DB manquant)" }, { status: 501, headers: corsHeaders() });
  let sub;
  try {
    sub = await request.json();
  } catch {
    return Response.json({ ok: false, error: "JSON invalide" }, { status: 400, headers: corsHeaders() });
  }
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return Response.json({ ok: false, error: "subscription incomplète" }, { status: 400, headers: corsHeaders() });
  }
  await ensurePushSchema(env);
  await env.DB.prepare(
    "INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth"
  )
    .bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString())
    .run();
  return Response.json({ ok: true }, { headers: corsHeaders() });
}

async function getAllPushSubscriptions(env) {
  await ensurePushSchema(env);
  const { results } = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all();
  return results.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
}

async function handlePushTest(env) {
  if (!env.DB || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return Response.json({ ok: false, error: "D1 ou clés VAPID manquantes" }, { status: 501, headers: corsHeaders() });
  }
  const subs = await getAllPushSubscriptions(env);
  const results = [];
  for (const sub of subs) {
    try {
      const res = await sendWebPush(env, sub, { title: "Persona5 Time Manager", body: "Notification de test 🔔" });
      results.push({ endpoint: sub.endpoint.slice(-20), status: res.status });
    } catch (err) {
      results.push({ endpoint: sub.endpoint.slice(-20), error: String(err) });
    }
  }
  return Response.json({ ok: true, sent: results.length, results }, { headers: corsHeaders() });
}
