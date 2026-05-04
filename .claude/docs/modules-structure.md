# Documentation : Structure des modules — Manga Tracker API

## Pattern standard d'un module

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

**Responsabilité** : Cache local des données MangaUpdates + synchronisation + recherche.

### Controller
```
GET  /mangas/popular         → getPopularMangas()
GET  /mangas/trending        → getTrendingMangas()
GET  /mangas/new             → getNewMangas()
GET  /mangas/search?q=...    → searchMangas()
GET  /mangas/:muId           → getMangaDetails()
POST /mangas/sync            → triggerSync() [admin]
```

### Services
- `MangasService` — Orchestration
- `SyncMangaService` — Sync depuis MangaUpdates (batch)
- `UpdateMangaService` — Mise à jour incrémentale
- `HelperService` — Parsing / transformation

### Entités
- `MangaEntity` — Cache manga
- `UserMangaEntity` — Relation user ↔ manga (bibliothèque + progression)

### DTOs
- `MangaQuickViewDto`, `MangaDetailsDto`, `SearchMangaDto`, `RetrieveMangaTrendsInternalDto`

---

## Module : `library`

**Responsabilité** : Bibliothèque de l'utilisateur — CRUD complet, statuts, progression.

### Controller
```
GET    /library                    → getUserLibrary()
GET    /library/:muId              → getMangaFromLibrary()
POST   /library                    → addMangaToLibrary()
DELETE /library/:muId              → removeMangaFromLibrary()
PATCH  /library/:muId/status       → updateReadingStatus()
PATCH  /library/:muId/chapter      → updateChapterProgress()
PATCH  /library/:muId/custom-link  → updateCustomLink()
```
Toutes les routes : `@UseGuards(AuthGuard('jwt'))`.

### Service
- Utilise `UserMangaEntity` pour le CRUD
- Filtre toujours par `userId` (`req.user.userId`)
- Lève `ChapterException`, `ReadingStatusException`

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
- `SaveMangaDto`, `UpdateReadingStatusDto`, `UpdateChapterDto`, `UpdateCustomLinkDto`

---

## Module : `user`

**Responsabilité** : Profil de l'utilisateur connecté.

### Controller
```
GET   /users/profile         → getProfile()
PATCH /users/name            → updateName()
PATCH /users/password        → updatePassword()
DELETE /users                → deleteAccount()
```
Toutes les routes : `@UseGuards(AuthGuard('jwt'))`.

### DTOs
- `UserInformationDto`, `UpdateNameDto`, `UpdatePasswordDto`

---

## Module : `user/auth`

**Responsabilité** : Authentification JWT.

### Controller
```
POST /auth/register   → register() [public, throttle 5/min]
POST /auth/login      → login() [public, throttle 5/min]
POST /auth/refresh    → refreshToken() [@UseGuards(AuthGuard('jwt-refresh')), throttle 10/min]
```

### Service
- `register()` — Hash bcrypt + créer `UserEntity` + tokens
- `login()` — Vérifier password + tokens
- `refreshToken()` — Valider refreshToken + nouveau accessToken
- `generateTokens()` — Signe accessToken + refreshToken

### Guards
- `AuthGuard('jwt')` — accessToken
- `AuthGuard('jwt-refresh')` — refreshToken

### Payload JWT
```typescript
{
  userId: string,
  email: string,
}
```

---

## Module : `api` (racine)

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
nest g module api/[nom]
nest g controller api/[nom]
nest g service api/[nom]
```

**Checklist création module** :
1. ✅ Créer `src/api/[nom]/`
2. ✅ Créer l'entité TypeORM (si données BDD) avec `uuid`, `@CreateDateColumn`, `@UpdateDateColumn`
3. ✅ Créer les DTOs avec `class-validator` + `@ApiProperty`
4. ✅ Créer le service avec `@InjectRepository()`
5. ✅ Créer le controller avec `@UseGuards`, `@ApiTags`
6. ✅ Déclarer dans `[nom].module.ts` avec `TypeOrmModule.forFeature([Entity])`
7. ✅ Importer dans `api.module.ts`
8. ✅ **Générer une migration TypeORM** si nouvelle entité (jamais `synchronize: true` en prod)
9. ✅ Mettre à jour `.claude/memory-bank/architecture.md`
10. ✅ Mettre à jour `.claude/memory-bank/progress.md`
