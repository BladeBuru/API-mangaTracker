# Secrets & `.env` — Garde-fou

> Snippet injecté automatiquement quand vous éditez un fichier `.env*`.

## Règles non-négociables

- ❌ **JAMAIS** committer un `.env` contenant des valeurs réelles (JWT keys, DB passwords, OAuth secrets).
- ✅ **Seul `template.env`** (sans valeurs sensibles, juste la liste des clés) peut être versionné.
- ✅ `.gitignore` doit contenir :
  ```
  *.env
  !template.env
  ```
- ✅ Les secrets sont injectés au runtime via :
  - GitHub Actions secrets pour la CI/CD
  - Docker secrets pour la prod
  - `.env.local` pour le dev (gitignored)

## Si vous éditez ce fichier maintenant

1. **Confirmer l'intention** :
   - Est-ce `template.env` (placeholders OK) ?
   - Ou un `.env` réel (à gitignorer ABSOLUMENT) ?

2. **Vérifier `.gitignore`** :
   ```bash
   git check-ignore -v <fichier>
   ```
   Si non ignoré → ajouter dans `.gitignore` AVANT toute écriture.

3. **Vérifier l'historique git** :
   ```bash
   git log --all --full-history -- "<fichier>"
   ```
   Si déjà committé avec des secrets → **rotation immédiate** des secrets concernés (regénérer JWT_KEY, GOOGLE_CLIENT_SECRET, mots de passe DB).

## Variables sensibles connues

À ne JAMAIS committer en clair :

- `JWT_KEY`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_SECRET`
- `GOOGLE_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` (parfois sensible)
- `DB_PASSWORD`
- Toute clé API tierce (Stripe, Sentry, etc.)
- Tokens d'accès, refresh tokens, session keys

## Format `template.env` (versionné)

```env
# PostgreSQL
DB_HOST=
DB_PORT=5432
DB_USERNAME=
DB_PASSWORD=
DB_DATABASE=

# JWT (générer avec : openssl rand -base64 64)
JWT_ACCESS_SECRET=
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_SECRET=
JWT_REFRESH_EXPIRATION=7d

# CORS (séparés par virgules)
CORS_ORIGINS=

# MangaUpdates
MANGAUPDATES_BASE_URL=https://api.mangaupdates.com/v1

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# App
PORT=3000
NODE_ENV=development
```
