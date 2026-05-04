# Déploiement — Manga Tracker API

## Architecture

```
GitHub Actions
    └── push master
          ├── 1. test          — Jest + lint (Postgres éphémère)
          ├── 2. build-push    — Docker image → bladeburu/manga-tracker-api:sha-XXXXXXXX
          ├── 3. deploy        — SSH NAS → midclt app.update → midclt app.start
          └── 4. smoke-test    — curl https://api.bladeburu.com/health (retry 5×)
```

## Fichiers du déploiement

| Fichier | Rôle |
|---------|------|
| `../.github/workflows/ci-cd.yml` | Workflow complet CI/CD |
| `compose.production.yml` | Template compose pour référence locale |

## Secrets GitHub requis (repo `BladeBuru/API-mangaTracker`)

| Secret | Description |
|--------|-------------|
| `DOCKERHUB_USER` | `bladeburu` |
| `DOCKERHUB_TOKEN` | Personal Access Token Docker Hub (read/write) |
| `NAS_HOST` | `bladeburu.com` |
| `NAS_PORT` | Port SSH externe exposé par NPMplus |
| `NAS_USER` | User SSH sur le NAS avec droits `midclt` |
| `NAS_SSH_KEY` | Clé privée Ed25519 (contenu complet, PEM) |
| `PROD_DB_PASSWORD` | Mot de passe DB PostgreSQL |
| `PROD_JWT_KEY` | Clé JWT access token (256 bits hex) |
| `PROD_JWT_REFRESH_SECRET` | Clé JWT refresh token (256 bits hex) |
| `PROD_SMTP_PASSWORD` | Clé SMTP Brevo (Master Password) |
| `PROD_GOOGLE_CLIENT_ID` | Google OAuth Client ID |
| `PROD_GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret |
| `PROD_ANDROID_SHA256_FINGERPRINT` | SHA-256 release + debug séparés par virgule |

## Rollback manuel

Si le déploiement se passe mal et que l'API ne répond plus :

```bash
# Se connecter au NAS
ssh -i ~/.ssh/manga-tracker -p <port> admin@192.168.1.119

# Voir les images disponibles
midclt call app.image.query | python3 -c "import json,sys; [print(i['repo_tags']) for i in json.load(sys.stdin)]"

# Mettre à jour le compose avec un tag précédent (ex: sha-abc12345)
# Modifier le tag dans le compose et relancer app.update + app.start
```

## Variables d'environnement

Toutes les variables sont définies dans le compose généré à la volée par le workflow.
La référence complète se trouve dans `compose.production.yml`.

**Variables sensibles** (ne jamais committer leurs valeurs) :
`DATABASE_PASSWORD`, `JWT_KEY`, `JWT_REFRESH_SECRET`, `SMTP_PASSWORD`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

## Première installation (Custom App TrueNAS)

Avant le premier déploiement automatique, l'app doit exister dans TrueNAS :
1. Ouvrir TrueNAS UI → Apps → Discover Apps → Custom App
2. Nom : `manga-tracker-api`
3. Image : `bladeburu/manga-tracker-api:latest`
4. Port : `3000:3000`
5. Cliquer Install — les env vars seront écrasées par le premier deploy CI
