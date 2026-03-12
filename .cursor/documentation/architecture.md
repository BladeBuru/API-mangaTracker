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
| `@nestjs/swagger` | 6.x | Documentation Swagger (disponible sur `/api`) |
| Jest + Supertest | — | Tests unitaires et e2e |

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
│   ├── envs/                     # Fichiers .env (development.env, template.env)
│   └── helper/
│       ├── date.helper.ts
│       └── env.helper.ts
├── shared/
│   ├── Decorator/
│   │   └── user.decorator.ts     # @GetUser() — extrait req.user
│   └── typeorm/
│       └── typeorm.service.ts    # Configuration TypeORM
├── app.module.ts
└── main.ts                       # Bootstrap (CORS, ValidationPipe, Swagger)
```

---

## Configuration `main.ts`

```typescript
// Éléments configurés au démarrage
- ValidationPipe global (whitelist: true, forbidNonWhitelisted: true)
- CORS activé
- Swagger sur /api (développement)
- Port via process.env.PORT || 3000
```

---

## Configuration TypeORM (`shared/typeorm/typeorm.service.ts`)

```typescript
// Variables d'environnement requises
DB_HOST       // Hôte PostgreSQL
DB_PORT       // Port (5432)
DB_USERNAME   // Utilisateur
DB_PASSWORD   // Mot de passe
DB_DATABASE   // Nom de la base

// Entités auto-chargées
entities: [MangaEntity, UserMangaEntity, UserEntity, ...]
synchronize: true  // Développement uniquement — à désactiver en production
```

---

## Modules métier

### `mangas` (`src/api/mangas/`)

**Rôle** : Gestion des mangas — synchronisation depuis MangaUpdates, stockage local, recherche

**Composants** :
```
mangas/
├── mangas.controller.ts         # Routes publiques et protégées
├── mangas.service.ts            # Orchestration
├── sync-manga.service.ts        # Synchronisation depuis MangaUpdates API
├── update-manga.service.ts      # Mise à jour des données existantes
├── helper.service.ts            # Utilitaires de parsing/transformation
├── manga.entity.ts              # Entité manga (cache local)
├── user-manga.entity.ts         # Relation utilisateur ↔ manga
├── constants.ts                 # Constantes (URLs, paramètres)
└── dto/
    ├── manga-details.dto.ts
    ├── manga-quick-view.dto.ts
    ├── search-manga.dto.ts
    └── retrieve-manga-trends-internal.dto.ts
```

---

### `library` (`src/api/library/`)

**Rôle** : Bibliothèque de l'utilisateur — CRUD, statuts de lecture, progression par chapitre

**Composants** :
```
library/
├── library.controller.ts
├── library.service.ts
├── library.module.ts
├── reading-status.enum.ts       # reading | completed | on_hold | dropped | plan_to_read
├── dto/
│   ├── save-manga.dto.ts         # Ajouter un manga
│   ├── update-chapter.dto.ts     # Mettre à jour la progression
│   ├── update-reading-status.dto.ts
│   └── update-custom-link.dto.ts
└── exceptions/
    ├── chapter.exception.ts
    └── reading-status.exception.ts
```

---

### `user` (`src/api/user/`)

**Rôle** : Profil utilisateur

```
user/
├── users.controller.ts
├── user.service.ts
├── user.module.ts
├── user.entity.ts               # Entité utilisateur
└── dto/
    ├── user-information.dto.ts
    ├── update-name.dto.ts
    ├── update-password.dto.ts
    └── find-all-user.dto.ts
```

---

### `user/auth` (`src/api/user/auth/`)

**Rôle** : Authentification JWT complète

```
auth/
├── auth.controller.ts           # POST /auth/register, /auth/login, /auth/refresh
├── auth.service.ts              # Logique (bcrypt, génération tokens)
├── auth.module.ts
├── auth.dto.ts                  # RegisterDto, LoginDto
├── auth.helper.ts               # Helpers bcrypt + JWT
└── guard/
│   ├── auth.guard.ts            # AuthGuard('jwt')
│   └── refreshToken.guard.ts    # AuthGuard('jwt-refresh')
└── strategy/
    ├── accessTokenStrategy.ts   # Valide l'accessToken, injecte req.user
    └── refreshTokenStrategy.ts  # Valide le refreshToken
```

**Flux d'authentification** :
```
POST /auth/register → hash password → créer user → retourner { accessToken, refreshToken }
POST /auth/login    → vérifier password → retourner { accessToken, refreshToken }
POST /auth/refresh  → vérifier refreshToken → retourner nouveau { accessToken }
```

---

## Données MangaUpdates

L'API consomme **MangaUpdates** (https://api.mangaupdates.com/v1) :
- URL configurée via `MANGAUPDATES_BASE_URL` dans les envs
- Module Axios configuré dans `api/config/http.module.ts`
- Synchronisation gérée par `SyncMangaService`
- Données stockées localement dans `MangaEntity` (cache)

---

## Variables d'environnement

```env
# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=password
DB_DATABASE=manga_tracker

# JWT
JWT_ACCESS_SECRET=your_access_secret
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_SECRET=your_refresh_secret
JWT_REFRESH_EXPIRATION=7d

# MangaUpdates
MANGAUPDATES_BASE_URL=https://api.mangaupdates.com/v1

# App
PORT=3000
```

Fichiers : `src/common/envs/development.env`, `src/common/envs/template.env`

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
