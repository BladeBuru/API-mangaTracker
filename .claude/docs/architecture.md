# Documentation Architecture — Manga Tracker API

## Stack technique

| Technologie | Version | Usage |
|------------|---------|-------|
| NestJS | 9.x | Framework principal |
| TypeScript | 4.7+ | Langage (strict mode) |
| TypeORM | 0.3.x | ORM PostgreSQL |
| PostgreSQL | 14+ | Base de données |
| `pg` | 8.x | Driver PostgreSQL |
| `@nestjs/jwt` + `passport-jwt` | — | Authentification JWT |
| `class-validator` + `class-transformer` | — | Validation DTOs |
| `@nestjs/swagger` | 6.x | Documentation Swagger (sur `/api`) |
| Jest + Supertest | — | Tests unitaires et e2e |

À installer / configurer (sécurité — voir `.claude/skills/secure-deployment/SKILL.md`) :

| Technologie | Usage |
|-------------|-------|
| `helmet` | Headers de sécurité HTTP |
| `@nestjs/throttler` | Rate limiting (global + renforcé sur /auth) |

---

## Structure du projet

```
src/
├── api/                          # Tous les modules métier
│   ├── config/
│   │   └── http.module.ts        # Configuration Axios (appels MangaUpdates)
│   ├── interceptors/
│   │   └── not-found.interceptor.ts
│   ├── library/                  # Bibliothèque utilisateur
│   ├── mangas/                   # Données mangas + synchronisation
│   ├── user/                     # Profil utilisateur + auth
│   │   └── auth/                 # JWT (login, register, refresh)
│   └── api.module.ts
├── common/
│   ├── envs/                     # Fichiers .env (template.env versionné, .env.* gitignored)
│   └── helper/
│       ├── date.helper.ts
│       └── env.helper.ts
├── shared/
│   ├── Decorator/
│   │   └── user.decorator.ts     # @GetUser() — extrait req.user
│   └── typeorm/
│       └── typeorm.service.ts    # Configuration TypeORM
├── migrations/                   # Migrations TypeORM (à créer si absent)
├── app.module.ts
└── main.ts                       # Bootstrap (helmet, CORS whitelist, ValidationPipe, Swagger, Throttler)
```

---

## Configuration `main.ts` (cible)

Voir `.claude/rules/nest-main-security.md` pour le template complet :

- ✅ `helmet()`
- ✅ CORS whitelist explicite (`process.env.CORS_ORIGINS`)
- ✅ ValidationPipe strict (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`, `transform`)
- ✅ Swagger conditionnel (non-prod ou auth-protected)
- ✅ Port via `process.env.PORT || 3000`

---

## Configuration TypeORM

Voir `.claude/rules/typeorm-config.md` pour le template :

```env
DB_HOST       # Hôte PostgreSQL
DB_PORT       # 5432
DB_USERNAME
DB_PASSWORD
DB_DATABASE
```

- `synchronize: false` (ou conditionnel non-prod)
- `migrations: ['dist/migrations/*.js']`
- `migrationsRun: true` en prod (ou via CI)
- `ssl: { rejectUnauthorized: true }` en prod

---

## Modules métier

### `mangas` (`src/api/mangas/`)

Cache local des données MangaUpdates + synchronisation + recherche.

```
mangas/
├── mangas.controller.ts         # Routes publiques et protégées
├── mangas.service.ts            # Orchestration
├── sync-manga.service.ts        # Synchronisation MangaUpdates API
├── update-manga.service.ts      # Mise à jour incrémentale
├── helper.service.ts            # Parsing/transformation
├── manga.entity.ts              # Cache local
├── user-manga.entity.ts         # Relation utilisateur ↔ manga
├── constants.ts
└── dto/
    ├── manga-details.dto.ts
    ├── manga-quick-view.dto.ts
    ├── search-manga.dto.ts
    └── retrieve-manga-trends-internal.dto.ts
```

### `library` (`src/api/library/`)

Bibliothèque de l'utilisateur — CRUD, statuts, progression.

```
library/
├── library.controller.ts
├── library.service.ts
├── library.module.ts
├── reading-status.enum.ts       # reading | completed | on_hold | dropped | plan_to_read
├── dto/
│   ├── save-manga.dto.ts
│   ├── update-chapter.dto.ts
│   ├── update-reading-status.dto.ts
│   └── update-custom-link.dto.ts
└── exceptions/
    ├── chapter.exception.ts
    └── reading-status.exception.ts
```

### `user` (`src/api/user/`)

Profil utilisateur.

```
user/
├── users.controller.ts
├── user.service.ts
├── user.module.ts
├── user.entity.ts
└── dto/
    ├── user-information.dto.ts
    ├── update-name.dto.ts
    ├── update-password.dto.ts
    └── find-all-user.dto.ts
```

### `user/auth` (`src/api/user/auth/`)

Authentification JWT complète.

```
auth/
├── auth.controller.ts           # POST /auth/register, /auth/login, /auth/refresh
├── auth.service.ts              # bcrypt + génération tokens
├── auth.module.ts
├── auth.dto.ts                  # RegisterDto, LoginDto
├── auth.helper.ts
├── guard/
│   ├── auth.guard.ts            # AuthGuard('jwt')
│   └── refreshToken.guard.ts    # AuthGuard('jwt-refresh')
└── strategy/
    ├── accessTokenStrategy.ts   # Valide accessToken, injecte req.user
    └── refreshTokenStrategy.ts  # Valide refreshToken
```

Flux :
```
POST /auth/register → hash password → créer user → { accessToken, refreshToken }
POST /auth/login    → vérifier password → { accessToken, refreshToken }
POST /auth/refresh  → vérifier refreshToken → nouveau { accessToken }
```

---

## Données MangaUpdates

L'API consomme **MangaUpdates** (`https://api.mangaupdates.com/v1`) :
- URL via `MANGAUPDATES_BASE_URL`
- Module Axios dans `api/config/http.module.ts`
- Sync via `SyncMangaService`
- Cache local dans `MangaEntity`

---

## Variables d'environnement

```env
# PostgreSQL
DB_HOST=
DB_PORT=5432
DB_USERNAME=
DB_PASSWORD=
DB_DATABASE=

# JWT (générer : openssl rand -base64 64)
JWT_ACCESS_SECRET=
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_SECRET=
JWT_REFRESH_EXPIRATION=7d

# CORS (whitelist par env)
CORS_ORIGINS=http://localhost:3000,https://app.manga-tracker.com

# MangaUpdates
MANGAUPDATES_BASE_URL=https://api.mangaupdates.com/v1

# OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# App
PORT=3000
NODE_ENV=development
```

Fichiers : `src/common/envs/template.env` (versionné), `.env.development` / `.env.production` (gitignored).

---

## Infrastructure locale (`toolbox/`)

```yaml
# toolbox/docker-compose.yml
services:
  postgres:
    image: postgres:14
    environment:
      POSTGRES_DB: manga_tracker
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
    ports:
      - "5432:5432"
```

Démarrer : `docker-compose -f toolbox/docker-compose.yml up -d`
