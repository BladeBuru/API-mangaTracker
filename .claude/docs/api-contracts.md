# Documentation : Contrats API — Manga Tracker API

## Format des réponses

### Succès — Réponse directe

```typescript
return { message: 'Success', data: result };
return mangaList;
return mangaDetail;
```

### Erreurs — Exceptions NestJS

```typescript
throw new NotFoundException(`Manga with muId '${muId}' not found`);
throw new BadRequestException('Field "readChaptersCount" must be >= 0');
throw new UnauthorizedException('Invalid or expired access token');
throw new ForbiddenException('You do not have access to this resource');
throw new ConflictException(`Manga '${muId}' is already in the library`);
```

**Règle absolue** : messages d'erreur clairs, descriptifs, en anglais technique. Pas de leak d'infos sensibles (jamais de stack trace, secret, ou détail d'implémentation).

---

## Endpoints par module

### Auth (`/auth`)

| Méthode | Route | Auth | Corps | Réponse | Throttle |
|---------|-------|------|-------|---------|----------|
| `POST` | `/auth/register` | Public | `{ email, password, name }` | `{ accessToken, refreshToken }` | 5/min |
| `POST` | `/auth/login` | Public | `{ email, password }` | `{ accessToken, refreshToken }` | 5/min |
| `POST` | `/auth/refresh` | RefreshToken | — | `{ accessToken }` | 10/min |

### Mangas (`/mangas`)

| Méthode | Route | Auth | Query | Réponse |
|---------|-------|------|-------|---------|
| `GET` | `/mangas/popular` | JWT | `page`, `limit` | `MangaQuickViewDto[]` |
| `GET` | `/mangas/trending` | JWT | `page`, `limit` | `MangaQuickViewDto[]` |
| `GET` | `/mangas/new` | JWT | `page`, `limit` | `MangaQuickViewDto[]` |
| `GET` | `/mangas/search` | JWT | `q`, `page`, `limit` | `MangaQuickViewDto[]` |
| `GET` | `/mangas/:muId` | JWT | — | `MangaDetailsDto` (+ `type` optionnel) |

### Accueil façon Netflix (`/mangas/home`) — contrat figé avec le client (2026-09-05)

| Méthode | Route | Auth | Query | Réponse |
|---------|-------|------|-------|---------|
| `GET` | `/mangas/home/sections` | JWT | `limit` (5..40, défaut 20) | `{ generatedAt, sections: HomeSectionDto[] }` |
| `GET` | `/mangas/home/sections/:id` | JWT | `page` (≥ 1, défaut 1), `limit` (5..40, défaut 40) | `{ id, kind, params, page, limit, total, items }` — 404 si id inconnu |

```typescript
// GET /mangas/home/sections?limit=20
{
  generatedAt: string;                       // ISO, date de génération (cache serveur ~10 min)
  sections: Array<{
    id: string;                              // 'latest' | 'popular' | 'community' | 'top_rated' | 'type:Manhwa' | 'genre:Action' | 'year:2014' | 'hidden_gems'
    kind: 'latest' | 'popular' | 'top_rated' | 'type' | 'genre' | 'year' | 'community' | 'hidden_gems';
    params: {} | { type: string } | { genre: string } | { year: number };
    items: MangaQuickViewDto[];              // muId, title, year, mediumCoverUrl, largeCoverUrl, rating (+ type?, genres?)
  }>;
}
```

- Aucun titre de section : le client traduit `kind` + `params`.
- Ordre décidé côté serveur : `latest`, `popular`, `community`, `top_rated`, `type:Manhwa`, `type:Manhua`, `type:Manga`, `genre:Action|Fantasy|Romance|Comedy|Drama|Adventure`, `year:<courante>`, `year:<précédente>`, `year:<rétro tournante>`, `hidden_gems`.
- Un titre n'apparaît que dans la première section qui le sélectionne (accueil uniquement) ; les sections de moins de 5 titres sont omises (les `type:*` peuvent manquer tant que `manga.type` n'est pas rattrapé).
- Ids acceptés en détail : sections fixes, `type:<type MU connu>`, `genre:<genre non NSFW/exclu>`, `year:<1930..courante>`. La page de détail n'est pas dédupliquée : sa première page peut différer de l'extrait de l'accueil.
- Aucun appel MangaUpdates au moment de la requête ; réponse < 300 ms après le premier appel (préchauffé au démarrage).

### Recommendations (`/recommendations`) — sensibles au type de publication

| Méthode | Route | Auth | Query | Réponse |
|---------|-------|------|-------|---------|
| `GET` | `/recommendations` | JWT | `limit`, `offset`, `genre?` | `MangaQuickViewDto[]` |
| `GET` | `/recommendations/by-genre` | JWT | `topGenres`, `perGenre` | `Record<genre, MangaQuickViewDto[]>` |
| `GET` | `/recommendations/sleepers` | JWT | `limit` | `MangaQuickViewDto[]` |

Les trois listes respectent le **profil de type** de la bibliothèque (part pondérée de Manga / Manhwa / Manhua…) : un lecteur à 80 % manhwa reçoit ≈ 80 % de manhwa sur chaque page, jamais zéro. Type inconnu (NULL) autorisé mais pénalisé quand la préférence est marquée.

**Source des candidats (2026-09-09)** — le contrat de réponse est INCHANGÉ (`MangaQuickViewDto`, mêmes champs), seule la provenance des titres évolue : le **graphe de voisinage œuvre-à-œuvre de MangaUpdates** (`category_recommendations` et `related_series` de `GET /v1/series/{id}`) devient la source principale, devant les suggestions manuelles et le complément « même genre, bien noté » du catalogue local. Mesuré sur la bibliothèque principale : 23 des 30 cartes venaient du catalogue local, 24 viennent désormais du voisinage MU. Les recos de la fiche détail (`GET /mangas/recommendations/:muId`) restent sur les seules suggestions manuelles + la liste communautaire — inchangées.

> **Attribution MangaUpdates (obligation d'usage)** : ces suggestions dérivent des données de [MangaUpdates](https://www.mangaupdates.com). Tout client qui les affiche doit porter une mention de crédit visible (« Suggestions fournies par MangaUpdates ») sous les listes de recommandations et sur la fiche détail.

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
| `PUT` | `/library/reading-position` | JWT | `{ muId, chapter, positionPercent }` | `{ ok: true }` — 400 hors bornes, 404 hors bibliothèque |
| `GET` | `/library/:muId/reading-position` | JWT | — | `{ chapter, positionPercent, updatedAt }` ou **204** si aucune position |

> ⚠️ Les lignes `PATCH /library/:muId/...` de ce tableau datent de la rétro-ingénierie et ne correspondent plus aux routes réelles (`PUT /library/chapter`, `/status`, `/custom-link`, `/rating`, corps portant `muId`). La référence à jour du module est [docs/specs/library/spec-technique.md](../../docs/specs/library/spec-technique.md).
>
> `PUT /library/reading-position` = position DANS un chapitre (reprise téléphone ↔ tablette). Elle n'écrit jamais `user_read_chapters` : « dernier chapitre terminé » et « endroit où l'on lit » sont deux notions distinctes.

### Users (`/users`)

| Méthode | Route | Auth | Corps | Réponse |
|---------|-------|------|-------|---------|
| `GET` | `/users/profile` | JWT | — | `UserInformationDto` |
| `PATCH` | `/users/name` | JWT | `{ name }` | `UserInformationDto` |
| `PATCH` | `/users/password` | JWT | `{ currentPassword, newPassword }` | `{ message }` |
| `DELETE` | `/users` | JWT | — | `{ message }` |

### Notifications (`/notifications`) — contrat partagé avec l'app (2026-10-13)

Toutes les routes : JWT, données de l'utilisateur courant uniquement.

| Méthode | Route | Réponse |
|---------|-------|---------|
| `GET` | `/notifications?limit=30&before=<ISO>` | 200 `{ items: NotificationDto[], unreadCount, nextBefore }` — tri `createdAt` décroissant ; `limit` défaut 30, valeurs > 50 ramenées à 50 ; `limit < 1` ou `before` non ISO → 400 |
| `GET` | `/notifications/unread-count` | 200 `{ count: number }` |
| `POST` | `/notifications/:id/read` | **200** `{ ok: true }` — idempotent ; 404 si inconnue, d'un autre utilisateur ou id non UUID |
| `POST` | `/notifications/read-all` | **200** `{ updated: number }` |

```typescript
NotificationDto {
  id: string;                 // uuid
  type: 'friend_request' | 'friend_accepted' | 'manga_share'
      | 'reading_group_invite' | 'new_chapters';
  createdAt: string;          // ISO 8601, précision ms
  readAt: string | null;
  actor: { id: number; username: string; displayName: string | null } | null;
  manga: { muId: number; title: string; coverUrl: string | null } | null;
  data:
    | { friendshipId: number }                                   // friend_request, friend_accepted
    | { shareId: number; message: string | null }                // manga_share
    | { groupId: number; groupName: string | null }              // reading_group_invite
    | { latestChapter: number; previousTotal: number; readChapters: number }; // new_chapters
}
```

- **Pagination** : repasser `nextBefore` en `before` ; `null` = dernière page. Les notifications qui partagent la date de la dernière ligne sont servies ensemble (une page peut alors dépasser `limit`).
- **`coverUrl`** = même URL que `mediumCoverUrl` des cartes manga (`manga.medium_cover_url`), `null` si inconnue.
- **`actor`** : `null` pour `new_chapters` et quand l'auteur a supprimé son compte.
- **`message` / `groupName`** relus en direct : `null` si le partage / le groupe a été supprimé.
- **`new_chapters`** : une seule non lue par (utilisateur, manga) — les hausses suivantes mettent à jour `latestChapter` / `readChapters`, gardent le `previousTotal` d'origine et remontent la notification en tête.
- **Effets de bord** : `friend_request` passe en lue à l'acceptation (ou au blocage) et disparaît si la demande est annulée / refusée (`DELETE /friends/:id`) ; `POST /sharing/inbox/mark-seen` marque aussi les `manga_share` lues.
- **Rétention** : lues supprimées après 30 jours, toutes après 90 jours (purge 03:15).

### Amis (`/friends`) — évolutions 2026-10-13

| Méthode | Route | Évolution |
|---------|-------|-----------|
| `GET` | `/friends/search?q=` | Cherche dans `username` **et** `displayName`, sans casse ni accents ; renvoie aussi les utilisateurs déjà en relation avec un champ **`relation`** : `'none' \| 'pending_sent' \| 'pending_received' \| 'friends'` (champs existants inchangés, 20 résultats max). Les relations bloquées restent masquées. |
| `GET` | `/friends/sent` | **Nouveau** — demandes envoyées en attente, même forme que `/friends/pending` (`FriendshipDto`, `direction: 'sent'`, l'autre utilisateur = le destinataire). |
| `POST` | `/friends/request` | Relation existante → **409** `"Demande d'amitié déjà envoyée"` ou `"Vous êtes déjà amis"` (400 avant) ; bloquée → 403 inchangé. |
| `DELETE` | `/friends/:id` | Le demandeur peut annuler sa demande en attente (déjà possible) ; la `friend_request` du destinataire est supprimée. |

### Codes et quotas modifiés (2026-10-13)

- `POST /sharing/inbox/mark-seen` et `POST /mangas/comments/:id/report` répondent **200** (201 avant).
- `POST /library/save` sur un manga déjà présent : **409** (400 avant).
- `PUT /library/chapter` : `total_chapters = 0` signifie « inconnu » → plus de 406, statut `reading` ; `readChapters` ≤ 100 000.
- `MangaQuickViewDto.rating` de `GET /library/all` (et bibliothèque d'un ami) : **nombre** (`7.5`), plus la chaîne décimale `"7.50"` ; `null` conservé.
- Rate limiting : le quota global (100/min) et les `@Throttle()` des routes publiques (auth, email) sont comptés par **IP client réelle** (dernier saut de `X-Forwarded-For` posé par NPMplus ; `CF-Connecting-IP` seulement si ce saut est un edge Cloudflare — en-têtes forgés ignorés) ; demande d'ami (5/min), commentaires / réponses / signalements (10/h), groupes de lecture (10/min), partage (30/min) sont comptés **par utilisateur**. En-têtes `X-RateLimit-*-<nom>` pour ces quotas nommés.

---

## DTOs principaux

### `MangaQuickViewDto`
```typescript
{
  muId: number;
  title: string;
  year: number;               // 0 = inconnu
  mediumCoverUrl: string;     // '' = inconnu
  largeCoverUrl: string;
  rating: number;             // 0 = inconnu
  type?: string;              // 'Manga' | 'Manhwa' | 'Manhua' | 'Novel' | 'OEL' … (absent si inconnu) — 2026-09-05
  genres?: string[];          // présent sur l'accueil et la bibliothèque — 2026-09-05
  readChapters?: number;
  totalChapters?: number;
  readingStatus?: ReadingStatus;
  associated?: { title: string }[];
  customLink?: string;
  userRating?: number;
  recommendedBecauseOf?: string[];
  communityRating?: number;
  communityRatingCount?: number;
  aggregatedRating?: number;
  userReportedTotalChapters?: number;
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

### Flux

```
1. Register/Login → { accessToken, refreshToken }
2. Requêtes protégées → Authorization: Bearer <accessToken>
3. Expiration accessToken → POST /auth/refresh avec refreshToken
4. Nouveau accessToken retourné
```

---

## Pagination

```typescript
?page=1&limit=20

// Réponse standard
{
  data: T[],
  page: number,
  limit: number,
  total: number,
  hasNext: boolean,
}
```

---

## Codes HTTP

| Code | Usage |
|------|-------|
| 200 | Succès (GET, PATCH, DELETE) |
| 201 | Création (POST) |
| 400 | Données invalides (validation DTO) |
| 401 | Token manquant ou invalide |
| 403 | Accès refusé |
| 404 | Ressource non trouvée |
| 409 | Conflit |
| 429 | Rate limit dépassé (Throttler) |
| 500 | Erreur serveur |

---

## CORS — Évolution multi-clients

L'API sert un Flutter Android (actuel), iOS (à venir), Web (à venir). La whitelist CORS doit refléter cette évolution :

```env
# .env.development
CORS_ORIGINS=http://localhost:3000,http://localhost:8080

# .env.production
CORS_ORIGINS=https://app.manga-tracker.com,https://manga-tracker.com
```

Quand le front web sera déployé : ajouter son domaine dans `CORS_ORIGINS` prod et re-déployer.

---

## Versioning

À prévoir si rupture de contrat (breaking change) : préfixer les routes `/v1/...` et créer `/v2/...` en parallèle, deprecate progressif. Les clients mobiles ne se mettent pas à jour instantanément.

---

## Swagger

Documentation interactive sur **`/api`** en non-production uniquement (ou auth-protected).

Chaque endpoint documenté avec :
- `@ApiTags('module')` sur le controller
- `@ApiOperation({ summary: '...' })` sur chaque endpoint
- `@ApiResponse({ status, description, type })` pour chaque statut
- `@ApiBearerAuth()` sur les controllers protégés
