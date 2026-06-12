# Stack technique du projet

> Fichier généré automatiquement par le subagent `stack-detector` lors de l'initialisation.
> Dernière détection : 2026-06-04

---

## Architecture générale

Projet **single-app** : une API REST NestJS autonome, sans frontend dans ce repo.
Le client consommateur principal est une application mobile Flutter (Android, iOS à venir).
Un client web est prévu (URL de prod : `https://app.bladeburu.com`).

---

## Backend

- **Framework :** NestJS 9 (`@nestjs/core ^9.0.0`, `@nestjs/common ^9.0.0`)
- **Langage :** TypeScript (`typescript ^4.7.4`) — mode non-strict (`noImplicitAny: false`, `strictNullChecks: false`)
- **Runtime :** Node.js 20 (cible Alpine dans Docker)
- **ORM :** TypeORM 0.3 (`typeorm ^0.3.15`, `@nestjs/typeorm ^9.0.1`)
- **Base de données :** PostgreSQL (`pg ^8.10.0`) — version 16 en CI, schema configurable (`DATABASE_SCHEMA`)
- **Auth :** JWT Passport — trois stratégies :
  - `accessTokenStrategy` — JWT court (1h, `JWT_KEY`)
  - `refreshTokenStrategy` — JWT long (7j, `JWT_REFRESH_SECRET`)
  - `googleStrategy` — OAuth2 Google (`passport-google-oauth20`)
- **Email :** `@nestjs-modules/mailer ^2.3.4` + `nodemailer ^8.0.7` + templates Handlebars — SMTP Brevo en prod
- **HTTP client :** `@nestjs/axios ^2.0.0` + `axios ^1.3.6` — utilisé pour les appels aux API externes
- **Validation :** `class-validator ^0.14.0` + `class-transformer ^0.3.1` + `class-sanitizer ^1.0.1`
- **Rate limiting :** `@nestjs/throttler ^6.5.0` — 100 req/min global, override explicite sur les routes sensibles
- **Sécurité HTTP :** `helmet ^8.1.0`
- **Config :** `@nestjs/config ^2.3.1` + fichiers `src/common/envs/<NODE_ENV>.env`

### Modules applicatifs

| Module | Chemin | Responsabilité |
|--------|--------|----------------|
| `UserModule` | `src/api/user/` | Profil utilisateur, RGPD, stats |
| `AuthModule` | `src/api/user/auth/` | Login, register, refresh, Google OAuth, magic-link email |
| `EmailModule` | `src/api/user/auth/email/` | Envoi emails transactionnels (Handlebars templates) |
| `GdprModule` | `src/api/user/gdpr/` | Endpoints RGPD (article 15, 17, 20), consentement |
| `LibraryModule` | `src/api/library/` | Bibliothèque manga de l'utilisateur, statuts de lecture, ratings, chapter logs |
| `MangasModule` | `src/api/mangas/` | Recherche/détails manga (MangaUpdates API), cover proxy, recommendations, ratings communautaires |
| `RecommendationModule` | `src/api/recommendations/` | Recommandations personnalisées |
| `FriendsModule` | `src/api/friends/` | Gestion des amis, friendships |
| `CommentsModule` | `src/api/comments/` | Commentaires manga, reports |
| `SharingModule` | `src/api/sharing/` | Partage de lectures, reading groups |
| `HealthModule` | `src/health/` | Endpoint `GET /health` pour healthcheck Docker |
| `WellKnownModule` | `src/api/well-known/` | Android App Links (`/.well-known/assetlinks.json`) |
| `GlobalHttpModule` | `src/api/config/http.module.ts` | HttpService partagé (timeout, max redirects) |

### API externes consommées

| Service | URL | Usage |
|---------|-----|-------|
| MangaUpdates API v1 | `https://api.mangaupdates.com/v1` | Recherche, détails manga, séries |
| MyAnimeList API v2 | `https://api.myanimelist.net/v2` | Trends manga (ranking) |

### Conventions backend

- **Séparation stricte** : Controller = routes HTTP uniquement, Service = logique métier, Repository via `@InjectRepository()`
- **Limites de taille** : Controller ≤ 200 lignes, Service ≤ 400 lignes, tout fichier ≤ 600 lignes
- **DTOs** : `class-validator` + `@ApiProperty()` sur tous les champs ; `UpdateDto extends PartialType(CreateDto)`
- **Pas de `any`** explicitement découragé (règle ESLint désactivée mais déconseillé)
- **Guards** : `@UseGuards(AuthGuard('jwt'))` sur toutes les routes privées
- **Décorateur** `@GetUser()` disponible dans `src/shared/Decorator/user.decorator.ts`
- **Path alias** : `@/*` → `./src/*` (configuré dans `tsconfig.json` et Jest)
- **Fichiers env** : `src/common/envs/<NODE_ENV>.env` — chargés via `getEnvPath()` ; `development.env` gitignored

### Structure des dossiers backend

```
src/
  main.ts                   # Bootstrap NestJS (helmet, CORS, ValidationPipe, Swagger)
  app.module.ts             # Root module (ConfigModule, TypeORM, Throttler)
  app.controller.ts         # Root controller (ping)
  app.service.ts
  api/
    api.module.ts           # Agrège tous les modules métier
    user/                   # User + Auth + GDPR + stats
    library/                # Bibliothèque utilisateur
    mangas/                 # Mangas (API externe + cache local)
    recommendations/        # Recommendations
    friends/                # Social — amis
    comments/               # Social — commentaires
    sharing/                # Social — partage / reading groups
    config/                 # HttpModule global
    well-known/             # Android App Links
  health/                   # Healthcheck endpoint
  common/
    envs/                   # Fichiers .env par environnement
    helper/                 # Helpers utilitaires (env.helper.ts)
  shared/
    typeorm/                # TypeOrmConfigService + data-source.ts
    Decorator/              # Décorateurs partagés (user.decorator.ts)
  migrations/               # Migrations TypeORM (14 migrations versionnées)
```

### Commandes backend

```bash
# Développement
npm run start:dev           # NestJS watch mode

# Build
npm run build               # nest build → dist/

# Production
npm run start:prod          # node dist/main

# Tests
npm test                    # Jest (unit)
npm run test:watch          # Jest watch
npm run test:cov            # Jest coverage
npm run test:e2e            # Jest e2e (test/jest-e2e.json)

# Migrations TypeORM
npm run migration:generate  # Génère une migration depuis les entités
npm run migration:run       # Applique les migrations en attente
npm run migration:revert    # Annule la dernière migration

# Qualité
npm run lint                # ESLint --fix
npm run format              # Prettier --write
```

---

## Frontend

Pas de frontend dans ce repo. Ce repo est une API pure.

Le client connu est une application Flutter (Android, iOS à venir, Web à venir).
Ce repo ne contient aucun fichier HTML, aucune dépendance React/Vue/Next/Angular.

---

## Backend externe

Non applicable — ce repo est le backend. Aucune dépendance vers un autre backend.

---

## Outils transverses

- **Gestionnaire de paquets :** npm (package-lock.json versionné, `npm ci` en CI)
- **Tests unitaires :** Jest 29.5.0 + ts-jest 29.0.5 + `@nestjs/testing`
- **Tests e2e :** Supertest (`supertest ^6.1.3`) + Jest (config `test/jest-e2e.json`)
- **Tests de contrat API :** Postman (workflow `postman-tests.yml` en CI)
- **Linter :** ESLint 8 + `@typescript-eslint` + `eslint-plugin-prettier`
- **Formatter :** Prettier 2 (singleQuote, trailingComma: all, endOfLine: auto)
- **CI/CD :** GitHub Actions — 4 workflows :
  - `ci-cd.yml` — tests + build Docker + push Docker Hub + deploy TrueNAS NAS + smoke-test HTTP
  - `code-quality.yml` — lint + format auto-commit (sur PR vers `dev`)
  - `db-backup.yml` — sauvegarde base de données
  - `postman-tests.yml` — tests de contrat Postman
- **Docker :** Dockerfile multi-stage (development / build / production) — image `node:20-alpine`, utilisateur non-root (`node`)
- **Docker Compose prod :** `deploy/compose.production.yml` — service unique avec healthcheck `GET /health`
- **Déploiement prod :** TrueNAS Scale via `midclt` (SSH + Python script), image `bladeburu/manga-tracker-api` sur Docker Hub
- **URL prod :** `https://api.bladeburu.com`
- **Monorepo :** Non — projet single-app

---

## Variables d'environnement clés

| Variable | Usage |
|----------|-------|
| `DATABASE_HOST/PORT/NAME/USER/PASSWORD/SCHEMA` | Connexion PostgreSQL |
| `JWT_KEY` + `JWT_KEY_EXPIRES_IN` | Access token JWT (défaut : 1h) |
| `JWT_REFRESH_SECRET` + `JWT_REFRESH_SECRET_EXPIRES_IN` | Refresh token JWT (défaut : 7j) |
| `CORS_ORIGINS` | Whitelist CORS (virgule-séparée) |
| `GOOGLE_CLIENT_ID/SECRET` | OAuth2 Google |
| `GOOGLE_CALLBACK_URL` | Callback OAuth Google |
| `SMTP_HOST/PORT/USER/PASSWORD/FROM/FROM_NAME` | Envoi email (Brevo en prod) |
| `PUBLIC_WEB_URL` | URL publique de l'API |
| `ANDROID_PACKAGE_NAME/SHA256_FINGERPRINT` | Android App Links |
| `NODE_ENV` | Contrôle Swagger (désactivé si `production`), CORS, logs |
| `PORT` | Port d'écoute (défaut : 3000) |

---

## TypeORM — Règles critiques

- `synchronize: false` en permanence (valeur en dur dans `TypeOrmConfigService`)
- `migrationsRun: true` uniquement en `production` (migrations auto au démarrage)
- En dev, appliquer les migrations manuellement via `npm run migration:run`
- Dossier `migrations/` versionné avec 14 migrations existantes
- Data source configurée dans `src/shared/typeorm/data-source.ts`
