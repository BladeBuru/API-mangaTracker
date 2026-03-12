# Documentation : Contrats API — Manga Tracker API

## Format des réponses

### Succès — Réponse directe

Les controllers retournent directement les données. Le format de base :

```typescript
// Objet simple
return { message: 'Success', data: result };

// Données directes (liste, objet)
return mangaList;
return mangaDetail;
```

### Erreurs — Exceptions NestJS

```typescript
// 404 — Ressource non trouvée
throw new NotFoundException(`Manga with muId '${muId}' not found`);

// 400 — Données invalides
throw new BadRequestException('Field "readChaptersCount" must be >= 0');

// 401 — Non authentifié
throw new UnauthorizedException('Invalid or expired access token');

// 403 — Non autorisé
throw new ForbiddenException('You do not have access to this resource');

// 409 — Conflit
throw new ConflictException(`Manga '${muId}' is already in the library`);
```

**Règle absolue** : Messages d'erreur clairs et descriptifs en anglais technique.

---

## Endpoints par module

### Auth (`/auth`)

| Méthode | Route | Auth | Corps | Réponse |
|---------|-------|------|-------|---------|
| `POST` | `/auth/register` | Public | `{ email, password, name }` | `{ accessToken, refreshToken }` |
| `POST` | `/auth/login` | Public | `{ email, password }` | `{ accessToken, refreshToken }` |
| `POST` | `/auth/refresh` | RefreshToken | — | `{ accessToken }` |

### Mangas (`/mangas`)

| Méthode | Route | Auth | Query | Réponse |
|---------|-------|------|-------|---------|
| `GET` | `/mangas/popular` | JWT | `page`, `limit` | `MangaQuickViewDto[]` |
| `GET` | `/mangas/trending` | JWT | `page`, `limit` | `MangaQuickViewDto[]` |
| `GET` | `/mangas/new` | JWT | `page`, `limit` | `MangaQuickViewDto[]` |
| `GET` | `/mangas/search` | JWT | `q`, `page`, `limit` | `MangaQuickViewDto[]` |
| `GET` | `/mangas/:muId` | JWT | — | `MangaDetailsDto` |

### Library (`/library`)

| Méthode | Route | Auth | Corps | Réponse |
|---------|-------|------|-------|---------|
| `GET` | `/library` | JWT | — | `MangaQuickViewDto[]` |
| `GET` | `/library/:muId` | JWT | — | `MangaQuickViewDto` |
| `POST` | `/library` | JWT | `{ muId }` | `UserMangaEntity` |
| `DELETE` | `/library/:muId` | JWT | — | `{ message }` |
| `PATCH` | `/library/:muId/status` | JWT | `{ readingStatus }` | `UserMangaEntity` |
| `PATCH` | `/library/:muId/chapter` | JWT | `{ readChaptersCount }` | `UserMangaEntity` |
| `PATCH` | `/library/:muId/custom-link` | JWT | `{ customLink }` | `UserMangaEntity` |

### Users (`/users`)

| Méthode | Route | Auth | Corps | Réponse |
|---------|-------|------|-------|---------|
| `GET` | `/users/profile` | JWT | — | `UserInformationDto` |
| `PATCH` | `/users/name` | JWT | `{ name }` | `UserInformationDto` |
| `PATCH` | `/users/password` | JWT | `{ currentPassword, newPassword }` | `{ message }` |
| `DELETE` | `/users` | JWT | — | `{ message }` |

---

## DTOs principaux

### `MangaQuickViewDto`
```typescript
{
  muId: string;           // Identifiant MangaUpdates
  title: string;
  coverUrl?: string;
  score?: number;         // Note MangaUpdates
  readingStatus?: ReadingStatus;
  readChaptersCount?: number;
}
```

### `MangaDetailsDto`
```typescript
{
  muId: string;
  title: string;
  description?: string;
  coverUrl?: string;
  score?: number;
  genres: string[];
  authors: AuthorDto[];
  chapters: SeasonChapterDto[];
  releaseStatus?: string;
  customLink?: string;
  readingStatus?: ReadingStatus;
  readChaptersCount?: number;
}
```

### `ReadingStatus` (enum)
```typescript
'reading' | 'completed' | 'on_hold' | 'dropped' | 'plan_to_read'
```

---

## Authentification

### Tokens JWT

```
AccessToken  : durée courte (15 min par défaut)
RefreshToken : durée longue (7 jours par défaut)
```

### Headers requis

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Flux complet

```
1. Register/Login → { accessToken, refreshToken }
2. Requêtes protégées → Authorization: Bearer <accessToken>
3. Expiration accessToken → POST /auth/refresh avec refreshToken
4. Nouveau accessToken retourné
```

---

## Pagination

```typescript
// Query params standards
?page=1&limit=20

// Réponse avec pagination (à implémenter)
{
  data: T[],
  page: number,
  limit: number,
  total: number,
  hasNext: boolean,
}
```

---

## Codes HTTP utilisés

| Code | Usage |
|------|-------|
| 200 | Succès (GET, PATCH, DELETE) |
| 201 | Création réussie (POST) |
| 400 | Données invalides (validation DTO) |
| 401 | Token manquant ou invalide |
| 403 | Accès refusé (pas le bon utilisateur) |
| 404 | Ressource non trouvée |
| 409 | Conflit (ex: manga déjà en bibliothèque) |
| 500 | Erreur serveur inattendue |

---

## Swagger

Documentation interactive disponible sur **`/api`** en mode développement.

Chaque endpoint est documenté avec :
- `@ApiTags('module')` sur le controller
- `@ApiOperation({ summary: '...' })` sur chaque endpoint
- `@ApiResponse({ status, description, type })` pour chaque statut
- `@ApiBearerAuth()` sur les controllers protégés
