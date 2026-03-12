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

---

## Structure du projet

```
src/
├── api/                        # Modules métier
│   ├── config/                 # Configuration HTTP (http.module.ts)
│   ├── interceptors/           # Intercepteurs globaux
│   ├── library/                # Gestion bibliothèque utilisateur
│   ├── mangas/                 # Mangas (sync, détails, recherche)
│   ├── user/                   # Utilisateurs
│   │   └── auth/               # Authentification JWT
│   └── api.module.ts
├── common/
│   ├── envs/                   # Fichiers .env (development.env, template.env)
│   └── helper/                 # Helpers (date.helper.ts, env.helper.ts)
├── shared/
│   ├── Decorator/              # Décorateurs custom (@GetUser)
│   └── typeorm/                # Configuration TypeORM (typeorm.service.ts)
├── app.module.ts
└── main.ts
```

---

## Modules métier

### `mangas`
- **Entités** : `MangaEntity`, `UserMangaEntity`
- **Services** : `MangasService`, `SyncMangaService`, `UpdateMangaService`, `HelperService`
- **DTOs** : `MangaDetailsDto`, `MangaQuickViewDto`, `SearchMangaDto`, `RetrieveMangaTrendsInternalDto`
- **Rôle** : Récupération depuis MangaUpdates API, synchronisation, détails

### `library`
- **Services** : `LibraryService`
- **DTOs** : `SaveMangaDto`, `UpdateChapterDto`, `UpdateCustomLinkDto`, `UpdateReadingStatusDto`
- **Enums** : `ReadingStatus` (reading, completed, on_hold, dropped, plan_to_read)
- **Exceptions** : `ChapterException`, `ReadingStatusException`
- **Rôle** : Bibliothèque utilisateur — CRUD, statuts, progression de lecture

### `user`
- **Entités** : `UserEntity`
- **Services** : `UserService`
- **DTOs** : `FindAllUserDto`, `UpdateNameDto`, `UpdatePasswordDto`, `UserInformationDto`
- **Rôle** : Profil utilisateur

### `user/auth`
- **Services** : `AuthService`
- **DTOs** : `AuthDto` (login/register)
- **Guards** : `AuthGuard` (jwt), `RefreshTokenGuard` (jwt-refresh)
- **Stratégies** : `AccessTokenStrategy`, `RefreshTokenStrategy`
- **Helpers** : `AuthHelper` (bcrypt, token generation)
- **Rôle** : Authentification complète JWT

---

## Pattern Controller/Service/Entity

### Controller
- Routes HTTP uniquement (MAX 200 lignes)
- Valide DTOs, appelle services, retourne réponses
- Toujours `@UseGuards(AuthGuard('jwt'))` pour les routes privées
- Passe `req.user.userId` au service

### Service
- Logique métier uniquement (MAX 400 lignes)
- Injecte `Repository<Entity>` via `@InjectRepository()`
- Lève des exceptions NestJS descriptives
- Si trop gros → extraire services spécialisés

### Entity
- Entité TypeORM avec `@Entity()`, `@Column()`, `@PrimaryGeneratedColumn('uuid')`
- Toujours `@CreateDateColumn()` + `@UpdateDateColumn()`
- Index sur colonnes fréquemment filtrées

---

## Authentification

```
POST /auth/register → Crée compte + retourne tokens
POST /auth/login    → Authentification + retourne tokens
POST /auth/refresh  → Renouvelle accessToken via refreshToken
```

- `req.user` dans les controllers contient `{ userId, email }` (injecté par Passport)
- Décorateur `@GetUser()` disponible dans `shared/Decorator/user.decorator.ts`

---

## Variables d'environnement

```
DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE
JWT_ACCESS_SECRET, JWT_ACCESS_EXPIRATION
JWT_REFRESH_SECRET, JWT_REFRESH_EXPIRATION
MANGAUPDATES_BASE_URL (API externe)
PORT
```

Fichiers : `common/envs/development.env`, `common/envs/template.env`
