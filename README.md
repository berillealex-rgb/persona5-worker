# persona5-worker

Version "vrai projet npm" du worker Cloudflare, nécessaire pour Pronote
(dépendance `pawnote`, impossible à coller dans le "Quick edit" du
dashboard). Déployée automatiquement via GitHub Actions à chaque push sur
`main`.

## Mise en place (une seule fois)

1. **Créer un nouveau repo GitHub** (ex: `persona5-worker`), vide.
2. Uploader tout le contenu de ce dossier dedans (via l'interface web GitHub :
   "Add file" > "Upload files", glisser tous les fichiers/dossiers en gardant
   la structure — y compris `.github/workflows/deploy.yml`).
3. **Créer un token API Cloudflare** :
   - dash.cloudflare.com → icône profil (en haut à droite) → "My Profile" →
     "API Tokens" → "Create Token"
   - Utilise le modèle **"Edit Cloudflare Workers"**
   - Limite-le à ton compte si demandé, puis "Continue to summary" → "Create Token"
   - Copie le token (affiché une seule fois)
4. **Récupérer ton Account ID** : dash.cloudflare.com → Workers & Pages →
   il est affiché dans la colonne de droite de la page d'accueil ("Account ID").
5. **Ajouter les secrets sur le repo GitHub** :
   - Repo → Settings → Secrets and variables → Actions → "New repository secret"
   - `CLOUDFLARE_API_TOKEN` = le token de l'étape 3
   - `CLOUDFLARE_ACCOUNT_ID` = l'ID de l'étape 4
6. Tout push sur `main` (donc chaque modification via l'éditeur GitHub)
   déclenche automatiquement le déploiement — regarde l'onglet "Actions" du
   repo pour voir si ça passe au vert.

## Après le premier déploiement

- Vérifie que le worker `persona5` a toujours ses bindings KV (`MEMORY`) et
  D1 (`DB`) dans le dashboard — ils sont déclarés dans `wrangler.toml` donc
  ça devrait rester intact, mais un coup d'œil ne fait pas de mal.
- Vérifie que le Cron Trigger existant est toujours là (redéclaré dans
  `wrangler.toml`, ajuste l'expression si la tienne était différente de
  "toutes les 15 min").
- Teste `/pronote/sync` depuis l'app (Options > Pronote) avec l'URL de
  l'établissement + identifiant/mot de passe du neveu. Si erreur du type
  "is not a function", voir les commentaires ⚠️ dans `src/index.js` (section
  Pronote) — il faudra juste ajuster un nom de fonction, pas réécrire la logique.
