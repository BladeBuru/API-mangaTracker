# Documentation : Structure des modules — Manga Tracker API

## Pattern standard d'un module

Chaque module suit la même structure et les mêmes conventions :

```
src/api/[module]/
├── [module].controller.ts      # Routes HTTP (MAX 200 lignes)
├── [module].service.ts         # Logique métier (MAX 400 lignes)
├── [module].module.ts          # Déclaration NestJS
├── [module].entity.ts          # Entité TypeORM (si données en base)
├── dto/
│   ├── create-[module].dto.ts
│   ├── update-[module].dto.ts
│   └── search-[module].dto.ts
└── exceptions/                 # Optionnel — exceptions métier
    └── [module].exception.ts
```

---

## Module : `mangas`

### Responsabilité
Cache local des données MangaUpdates + synchronisation + recherche.

### Controller (`mangas.controller.ts`)
```
GET  /mangas/popular         → getPopularMangas()
GET  /mangas/trending        → getTrendingMangas()
GET  /mangas/new             → getNewMangas()
GET  /mangas/search?q=...    → searchMangas()
GET  /mangas/:muId           → getMangaDetails()
POST /mangas/sync            → triggerSync() [admin]
```

### Services
- `MangasService` — Orchestration, point d'entrée du controller
- `SyncMangaService` — Synchronisation depuis MangaUpdates API (batch)
- `UpdateMangaService` — Mise à jour incrémentale des données
- `HelperService` — Transformation / parsing des données MangaUpdates

### Entités
- `MangaEntity` — Cache manga (muId, title, description, coverUrl, genres, etc.)
- `UserMangaEntity` — Relation utilisateur ↔ manga (bibliothèque + progression)

### DTOs
- `MangaQuickViewDto` — Vue résumée pour les listes (muId, title, coverUrl, score)
- `MangaDetailsDto` — Détails complets (auteurs, genres, chapitres, liens)
- `SearchMangaDto` — Recherche (query, page, limit)
- `RetrieveMangaTrendsInternalDto` — DTO interne pour les tendances

---

## Module : `library`

### Responsabilité
Bibliothèque de l'utilisateur connecté — CRUD complet, statuts, progression.

### Controller (`library.controller.ts`)
```
GET    /library                    → getUserLibrary()
GET    /library/:muId              → getMangaFromLibrary()
POST   /library                    → addMangaToLibrary()
DELETE /library/:muId              → removeMangaFromLibrary()
PATCH  /library/:muId/status       → updateReadingStatus()
PATCH  /library/:muId/chapter      → updateChapterProgress()
PATCH  /library/:muId/custom-link  → updateCustomLink()
```
Toutes les routes protégées par `@UseGuards(AuthGuard('jwt'))`.

### Service (`library.service.ts`)
- Utilise `UserMangaEntity` pour les opérations CRUD
- Filtre toujours par `userId` (provenant de `req.user.userId`)
- Lève des exceptions métier via `ChapterException`, `ReadingStatusException`

### Enum `ReadingStatus`
```typescript
enum ReadingStatus {
  READING = 'reading',
  COMPLETED = 'completed',
  ON_HOLD = 'on_hold',
  DROPPED = 'dropped',
  PLAN_TO_READ = 'plan_to_read',
}
```

### DTOs
- `SaveMangaDto` — `{ muId: string }`
- `UpdateReadingStatusDto` — `{ readingStatus: ReadingStatus }`
- `UpdateChapterDto` — `{ readChaptersCount: number }`
- `UpdateCustomLinkDto` — `{ customLink: string }`

---

## Module : `user`

### Responsabilité
Profil de l'utilisateur connecté.

### Controller (`users.controller.ts`)
```
GET   /users/profile         → getProfile()
PATCH /users/name            → updateName()
PATCH /users/password        → updatePassword()
DELETE /users                → deleteAccount()
```
Toutes les routes protégées par `@UseGuards(AuthGuard('jwt'))`.

### DTOs
- `UserInformationDto` — Réponse profil (id, email, name, createdAt)
- `UpdateNameDto` — `{ name: string }`
- `UpdatePasswordDto` — `{ currentPassword: string, newPassword: string }`

---

## Module : `user/auth`

### Responsabilité
Authentification complète JWT.

### Controller (`auth.controller.ts`)
```
POST /auth/register   → register() [public]
POST /auth/login      → login() [public]
POST /auth/refresh    → refreshToken() [@UseGuards(AuthGuard('jwt-refresh'))]
```

### Service (`auth.service.ts`)
- `register()` — Hash password bcrypt + créer `UserEntity` + retourner tokens
- `login()` — Vérifier password bcrypt + retourner tokens
- `refreshToken()` — Valider refreshToken + retourner nouveau accessToken
- `generateTokens()` — Signe accessToken (15min) + refreshToken (7j)

### Guards
- `AuthGuard('jwt')` — Valide l'accessToken sur les routes privées
- `AuthGuard('jwt-refresh')` — Valide le refreshToken uniquement sur `/auth/refresh`

### Payload JWT
```typescript
// req.user après validation par AccessTokenStrategy
{
  userId: string,   // ID de l'utilisateur
  email: string,
}
```

---

## Module : `api` (racine)

### `api.module.ts`
Importe tous les modules métier :
```typescript
@Module({
  imports: [
    MangasModule,
    LibraryModule,
    UserModule,       // inclut AuthModule
  ],
})
export class ApiModule {}
```

---

## Créer un nouveau module

```bash
# Via NestJS CLI
nest g module api/[nom]
nest g controller api/[nom]
nest g service api/[nom]
```

**Checklist création module** :
1. ✅ Créer le dossier `src/api/[nom]/`
2. ✅ Créer l'entité TypeORM (si données en BDD) avec `uuid`, `@CreateDateColumn`, `@UpdateDateColumn`
3. ✅ Créer les DTOs avec `class-validator` + `@ApiProperty`
4. ✅ Créer le service avec `@InjectRepository()`
5. ✅ Créer le controller avec `@UseGuards`, `@ApiTags`
6. ✅ Déclarer dans `[nom].module.ts` avec `TypeOrmModule.forFeature([Entity])`
7. ✅ Importer dans `api.module.ts`
8. ✅ Mettre à jour `memory-bank/architecture.md`
