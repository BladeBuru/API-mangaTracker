# Architecture — Manga Tracker API

## Stack technique

- **Framework** : NestJS 9
- **ORM** : TypeORM 0.3 + PostgreSQL (`pg`)
- **Auth** : JWT Passport — `@nestjs/passport`, `@nestjs/jwt`, `passport-jwt`
  - AccessToken (courte durée) via stratégie `jwt`
  - RefreshToken (longue durée) via stratégie `jwt-refresh`
- **Validation** : `class-validator` + `class-transformer`
- **Documentation** : Swagger (`@nestjs/swagger`) — disponible sur `/api`
- **Tests** : Jest + Supertest
- **Env** : `dotenv` via `@nestjs/config` — fichiers dans `common/envs/`
- **Sécurité (cible)** : `helmet` + `@nestjs/throttler` (à installer si absent — voir progress.md)

---

## Structure du projet

```
src/
├── api/                        # Modules métier
│   ├── config/                 # Configuration HTTP (http.module.ts)
│   ├── interceptors/
│   ├── library/                # Bibliothèque utilisateur
│   ├── mangas/                 # Mangas (sync, détails, recherche)
│   ├── user/                   # Utilisateurs
│   │   └── auth/               # JWT
│   └── api.module.ts
├── common/
│   ├── envs/                   # template.env (versionné), .env.* (gitignored)
│   └── helper/
├── shared/
│   ├── Decorator/              # @GetUser
│   └── typeorm/                # typeorm.service.ts
├── migrations/                 # Migrations TypeORM (à créer)
├── app.module.ts
└── main.ts
```

---

## Modules métier

### `mangas`
- **Entités** : `MangaEntity` (dont `type` : Manga / Manhwa / Manhua…), `UserMangaEntity`, `CatalogSyncState`
- **Services** : `MangasService`, `SyncMangaService`, `UpdateMangaService`, `HelperService`
- **Jobs MU** (un seul à la fois via `MuJobLockService`) : `CatalogTypeBackfillService` (01:00 + boot), `CatalogReleasesService` (02:00), `CatalogSyncService` (03:30) → `CatalogShardRunnerService` (passe de shard partagée), `CatalogPageIngestService`, `CatalogShardPlannerService`, `CatalogHydrationService`
- **Accueil** (`home/`) : `HomeSectionsController` (`/mangas/home/sections`), `HomeSectionsService` (cache SWR 10 min, dédup), `HomeSectionQueryBuilder` (règles SQL), `home-section.catalog.ts` (définitions pures)
- **DTOs** : `MangaDetailsDto`, `MangaQuickViewDto` (+ `type`, `genres`), `SearchMangaDto`, `RetrieveMangaTrendsInternalDto`, `home/dto/home-sections.dto.ts`
- **Rôle** : Récupération depuis MangaUpdates API, sync, détails, catalogue local, accueil

### `recommendations`
- **Services** : `RecommendationService` (scoring par affinité), `SleeperHitsService` (sleepers + cold start), `RecommendationDtoBuilderService` (pool → cartes, prorata de type), `GenreSectionService`, `CatalogCandidateService`, `DismissalService`, `RecoCacheService`
- **Pur** : `type-profile.ts` (profil de type, `interleaveByTypeMix`, buckets de requête par type)
- **Rôle** : `/recommendations`, `/recommendations/by-genre`, `/recommendations/sleepers`, rejets — toutes sensibles au type de publication

### `library`
- **Services** : `LibraryService`
- **DTOs** : `SaveMangaDto`, `UpdateChapterDto`, `UpdateCustomLinkDto`, `UpdateReadingStatusDto`
- **Enums** : `ReadingStatus`
- **Exceptions** : `ChapterException`, `ReadingStatusException`
- **Rôle** : Bibliothèque utilisateur — CRUD, statuts, progression

### `user`
- **Entités** : `UserEntity`
- **Services** : `UserService`
- **DTOs** : `FindAllUserDto`, `UpdateNameDto`, `UpdatePasswordDto`, `UserInformationDto`
- **Rôle** : Profil utilisateur

### `user/auth`
- **Services** : `AuthService`
- **DTOs** : `AuthDto`
- **Guards** : `AuthGuard` (jwt), `RefreshTokenGuard` (jwt-refresh)
- **Stratégies** : `AccessTokenStrategy`, `RefreshTokenStrategy`
- **Helpers** : `AuthHelper`
- **Rôle** : Authentification JWT

---

## Pattern Controller/Service/Entity

### Controller
- Routes HTTP uniquement (MAX 200 lignes)
- Valide DTOs, appelle services, retourne réponses
- `@UseGuards(AuthGuard('jwt'))` sur routes privées
- Passe `req.user.userId` au service

### Service
- Logique métier uniquement (MAX 400 lignes)
- Injecte `Repository<Entity>` via `@InjectRepository()`
- Lève des exceptions NestJS descriptives
- Si trop gros → services spécialisés

### Entity
- TypeORM avec `@Entity()`, `@Column()`, `@PrimaryGeneratedColumn('uuid')`
- `@CreateDateColumn()` + `@UpdateDateColumn()` toujours
- Index sur colonnes fréquemment filtrées
- **Migration TypeORM générée à chaque modification** (jamais `synchronize: true` en prod)

---

## Authentification

```
POST /auth/register → Crée compte + tokens (throttle 5/min)
POST /auth/login    → Authentification + tokens (throttle 5/min)
POST /auth/refresh  → Renouvelle accessToken via refreshToken (throttle 10/min)
```

- `req.user` contient `{ userId, email }` (Passport)
- `@GetUser()` disponible dans `shared/Decorator/user.decorator.ts`

---

## Variables d'environnement

```
DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE
JWT_ACCESS_SECRET, JWT_ACCESS_EXPIRATION
JWT_REFRESH_SECRET, JWT_REFRESH_EXPIRATION
MANGAUPDATES_BASE_URL
CORS_ORIGINS  (whitelist explicite par environnement)
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (si OAuth)
PORT, NODE_ENV
```

Fichiers : `common/envs/template.env` (versionné), `.env.development` / `.env.production` (gitignored).
