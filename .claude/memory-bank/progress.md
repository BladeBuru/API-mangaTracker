# Progrès — Manga Tracker API

> Dernière mise à jour : Mai 2026

---

## ✅ Fonctionnalités complétées

### Authentification (`user/auth`)
- ✅ Register (création de compte + hashage bcrypt)
- ✅ Login (validation + génération AccessToken + RefreshToken)
- ✅ Refresh token (renouvellement accessToken)
- ✅ Guards JWT (`AuthGuard('jwt')`, `AuthGuard('jwt-refresh')`)
- ✅ Stratégies Passport (`AccessTokenStrategy`, `RefreshTokenStrategy`)
- ✅ Google OAuth (intégré, voir auth.controller.ts)
- ✅ **[Phase 1 — Mai 2026]** Sessions hardening : `createSession` est toujours créé AVANT `update(lastLoginAt)` (login, refresh, issueTokensForUserId, findOrCreateGoogleUser) — évite un lastLoginAt updaté sans session retournée si la BDD plante au milieu
- ✅ **[Phase 1 — Mai 2026]** `refresh()` : nouvelle session créée AVANT suppression de l'ancienne (avec `.catch()` non-bloquant sur delete) — évite la déconnexion définitive si createSession échoue
- ✅ **[Username unique — 2026-05-18]** Migration `1746231500000-AddUsernameUniqueIndex` : index unique `UQ_user_username_lower` sur `LOWER(username)` (Postgres) — pre-check des doublons avant création, le `up()` throw avec liste des conflits si présents. `register()` ajoute un check `ILike(name)` qui retourne 409 "Nom d'utilisateur déjà pris" — `John` et `john` ne peuvent plus coexister.

### Utilisateurs (`user`)
- ✅ Récupération du profil utilisateur
- ✅ Mise à jour du nom
- ✅ Changement de mot de passe (bcrypt)
- ✅ Suppression de compte
- ✅ **[Phase 2 — Mai 2026]** Endpoint `GET /user/stats` (StatsModule) : agrège `mangasByStatus`, `totalChaptersRead`, `estimatedReadingTimeMinutes`, `topGenres`, `lastReadAt`, `completionRate`, `accountCreatedAt`, `totalMangas` depuis `user_manga` + `manga.genres`
- ✅ **[Phase 2 — Mai 2026]** Migration `1746230900000-AddCreatedAtToUser` : colonne `User.createdAt` (CreateDateColumn) — défaut `CURRENT_TIMESTAMP` pour les comptes existants
- ✅ **[Phase 3 — Mai 2026]** Profil étendu : migration `1746231000000-AddProfileFieldsToUser` ajoute `avatarUrl`, `displayName`, `bio`, `dateOfBirth`, `gender`, `isProfilePublic` (privacy-by-default = false)
- ✅ **[Phase 3 — Mai 2026]** Endpoint `PATCH /user/profile` (DTO validé class-validator) + `GET /user/profile/:id` (profil public si opt-in, sinon 403)
- ✅ **[Phase 3 — Mai 2026]** `UserInformationDto.fromEntity` enrichi (renvoie les nouveaux champs), `GdprExport` étend la section `account` (RGPD article 20)
- 🔴 **[Phase 3 TODO]** Upload avatar multipart : nécessite `multer` + `sharp` (resize 256×256) + volume Docker `/uploads/avatars/` monté sur NAS `Pool 1/ix-apps/app_mounts/mangatracker-uploads`. À implémenter dans une session dédiée.

### Mangas (`mangas`)
- ✅ Récupération populaires / tendances / nouveaux
- ✅ Récupération des détails (MangaUpdates API)
- ✅ Recherche
- ✅ `SyncMangaService`, `UpdateMangaService`
- ✅ Entités `MangaEntity` + `UserMangaEntity`
- ✅ **[Phase 4 — Mai 2026]** `CoverProxyService` + endpoint public `GET /mangas/:muId/cover?size=small|medium` : fetch upstream MU, auto-refresh si 404, headers `Cache-Control: public, max-age=2592000, immutable` (30j) → NPMplus + cached_network_image cachent côté CDN/client. Élimine les placeholders côté Flutter.
- ✅ **[Phase 4.1 — 2026-05-18]** Refactor cover proxy en **302 redirect** au lieu de fetch+stream Node-side. Raison : MU CDN bloquait notre User-Agent et le path `/thumb/` était cassé. Maintenant on **redirige le browser** vers `medium_cover_url` (l'URL "original" qui marche), browser/CDN cache nativement. `Cache-Control` réduit à `max-age=300` (5 min) pour ne plus piéger les 404 dans le cache immutable.
- ✅ **[Phase 4.1 — 2026-05-18]** `pickUrl()` retourne toujours `medium_cover_url` (peu importe `size=small` demandé) car `/thumb/iXXX.jpg` MU renvoie 404 alors que `/iXXX.png` marche.
- ✅ **[Search fix — 2026-05-18]** `MangasService.searchManga` : `safeLimit = limit ?? 20`, `safeOffset = offset ?? 1`. MU API a durci leur validation (`perpage` doit être int > 0) — sans fallback, on envoyait `perpage: null` et MU répondait 400 Field Validation Error.
- ✅ **[Search fix — 2026-05-18]** Logging détaillé du body MU response en cas d'échec (`code`, `status`, `body`, `payload`) au lieu de juste `ERR_BAD_REQUEST` opaque.
- ✅ **[Cover refresh bug — 2026-05-18]** `MangaDetailsDto.fromMU()` (`manga-details.dto.ts:306-362`) assignait les valeurs MU avec des clés snake_case (`mangaDetailsDto['small_cover_url']`, `['medium_cover_url']`, `['total_chapters']`, `['mu_id']`) en bracket-notation, alors que le DTO déclare ses propriétés en camelCase (`smallCoverUrl`, `mediumCoverUrl`, `totalChapters`, `muId`). Conséquence : les consumers (`mangas.service.ts:154-157`, `sync-manga.service.ts:24,32-33`) lisaient `details.smallCoverUrl` → `undefined` → `repo.update(id, {small_cover_url: undefined})` ne touchait pas la colonne. Toutes les covers/total_chapters restaient NULL pour les mangas dont la fiche n'avait jamais été ouverte avant le fix, et `POST /mangas/:muId/refresh-cover` renvoyait `404 No cover URL after refresh`. Fix : toutes les assignations passées en `.camelCase` + suppression d'un bloc dupliqué `total_chapters`/`seasonChapters`/`bonusChapters`. Aucune migration, aucun changement d'entity. Validé : `GET /mangas/70994361491/cover?size=medium` → 302 Found avec URL MU valide.
- ✅ **[Recommandations communauté — 2026-05-18]** L'endpoint `GET /mangas/recommendations/:muId` créait des stubs `manga` via `saveRecommendations` sans `medium_cover_url` (NULL), car le type `muRecommendations` du DTO n'incluait pas le champ `series_image.url.{thumb,original}` que MU expose dans `/series/{muId}` pour chaque reco. L'enrichissement des covers reposait sur un fire-and-forget `getMangaDetails` (background, fragile). Résultat : à la première ouverture du dialog "Mangas recommandés", 3/5 cartes affichaient un placeholder gris → perception "Impossible de récupérer les recommandations". Fix : extension du type `muRecommendations` avec `small_cover_url`/`medium_cover_url`, mapping `series_image.url.{thumb,original}` dans `fromMU`, `saveRecommendations` insère les covers sur les stubs neufs (avec `orIgnore` préservé pour ne pas écraser un manga complet), retro-fix `UPDATE manga SET medium_cover_url = ... WHERE medium_cover_url IS NULL` sur les stubs antérieurs. Validé : `GET /mangas/recommendations/55099564912` retourne 5 items avec `mediumCoverUrl` renseigné dès la 1re réponse (Fairy Tail, Hagane no R., Berserk, Naruto, Bleach).
- ✅ **[Entity.fromMU bracket-notation fix — 2026-05-18]** Audit en background a remonté un 2ᵉ bug du même pattern dans `manga.entity.ts:68-101`. `Manga.fromMU()` lisait avec des clés snake_case (`mangaDetailsDto['small_cover_url']`) puis fallback `?? mangaDetailsDto['smallCoverUrl']`. Le DTO étant déclaré camelCase, la 1ʳᵉ branche était toujours `undefined` — le fallback masquait le bug sans le réparer. Refactoré pour lire directement les propriétés typées du DTO (`manga.small_cover_url = mangaDetailsDto.smallCoverUrl`). Les propriétés de l'entité restent en snake_case (TypeORM mappe property → colonne directement). `tsc --noEmit` clean.

### Bibliothèque (`library`)
- ✅ Add / Remove / List / Get manga
- ✅ Update reading status
- ✅ Update chapter progress
- ✅ Update custom link
- ✅ **[Phase 5 — Mai 2026]** Table `user_manga_chapter_log` (migration `1746231100000`) : trace les sessions de lecture (replay, skip, bonus, scroll position) en mode additif au pointeur `user_read_chapters`
- ✅ **[Phase 5 — Mai 2026]** `ChapterLogService` + endpoints `POST /library/:muId/chapter-log` (record session), `GET /library/:muId/chapter-log` (historique), `PUT /library/:muId/chapter/:n/skip` (toggle skip)

### Amis (`friends`) — Phase 6
- ✅ **[Phase 6 — Mai 2026]** Table `user_friendship` (migration `1746231200000`) + entity avec statut `pending|accepted|blocked`, unicité (requester, addressee), 2 index par statut
- ✅ **[Phase 6 — Mai 2026]** `FriendsModule` + `FriendsController` (JWT) avec endpoints :
  - `POST /friends/request` (throttle 5/min anti-spam — accepte addresseeId OU addresseeUsername, auto-accept si demande inverse pending)
  - `GET /friends` (liste acceptés)
  - `GET /friends/pending` (demandes reçues en attente)
  - `GET /friends/search?q=...` (autocomplete, min 2 chars, exclut user courant + relations existantes, limite 20)
  - `PATCH /friends/:id` (accept/reject/block — addressee uniquement)
  - `DELETE /friends/:id` (les deux côtés peuvent supprimer)
- ✅ **[Case-insensitive — 2026-05-18]** `friends.service.ts` : `Like` → `ILike` partout (recherche autocomplete + lookup `addresseeUsername` dans `sendRequest`). Avant, `john` ne trouvait pas `John` — frustrant côté UX. Maintenant cohérent avec l'unicité `LOWER(username)` côté DB.

### Commentaires (`comments`) — Phase 7
- ✅ **[Phase 7 — Mai 2026]** Tables `manga_comment` + `comment_report` (migration `1746231300000`) : threading 1 niveau via `parent_comment_id`, soft delete (`isDeleted`), rating optionnel (review attachée)
- ✅ **[Phase 7 — Mai 2026]** `CommentsModule` + endpoints (JWT, throttle 10/heure sur écritures) :
  - `GET /mangas/:muId/comments?page&sort=top|recent` (paginé, 20/page)
  - `GET /mangas/comments/:commentId/replies`
  - `POST /mangas/:muId/comments` + `POST /mangas/comments/:id/reply`
  - `PATCH /mangas/comments/:id` (auteur uniquement)
  - `DELETE /mangas/comments/:id` (soft delete, auteur uniquement)
  - `POST /mangas/comments/:id/report` (modération, unicité user/comment)
- ✅ **[Phase 7 — Mai 2026]** Filtre NSFW basique (regex mots interdits) sur création/édition

### Partage entre amis (`sharing`) — Phase 8
- ✅ **[Phase 8 — Mai 2026]** Migration `1746231400000` : tables `manga_share` (event log share avec `message`, `seenAt`), `reading_group` + `reading_group_member` (skeleton lecture à deux)
- ✅ **[Phase 8 — Mai 2026]** `SharingModule` + endpoints :
  - `POST /sharing/manga/:muId` (throttle 30/min, max 20 destinataires, vérifie amitié acceptée, idempotence sur non-vu)
  - `GET /sharing/inbox` (shares reçus, plus récents en premier, limit 100)
  - `POST /sharing/inbox/mark-seen` (marquer toutes vues, badge à 0)
  - `GET /sharing/inbox/unseen-count` (badge BottomNavBar)
- ✅ **[Phase 8.3 — Mai 2026]** Reading groups CRUD complet : `ReadingGroupsModule`/`ReadingGroupsService` + 5 endpoints (`POST /reading-groups` création + invitations initiales, `GET /reading-groups` mes groupes, `GET /reading-groups/:id` détail avec progression cross-membres, `POST /reading-groups/:id/invite`, `DELETE /reading-groups/:id/leave`). Max 10 membres par groupe. Si l'owner quitte et qu'il reste des membres, l'ownership est transféré au plus ancien. Vérif amitié acceptée pour toute invitation (anti-spam). Progression lue à la volée depuis `user_manga` (pas de duplication).
- ✅ **[Idempotence — 2026-05-18]** `createGroup` : si un groupe `(owner, manga)` existe déjà, on l'utilise au lieu d'en créer un doublon. Les nouveaux amis de `inviteFriendIds` sont ajoutés comme membres (skip ceux déjà membres). Évite le bug "je clique 2× sur Lire à deux et j'ai 2 groupes identiques".
- ✅ **[Progression bug fix — 2026-05-18]** `fetchProgressForGroup` : Postgres lowercase les alias non-quotés (`AS userId` → `userid` dans le résultat raw). Refactor avec alias lowercase explicites (`userid`, `readchapters`) + `Number.isFinite()` check sur les valeurs lues. Avant, `progressByUser` était toujours vide → la progression des membres ne s'affichait jamais côté Flutter.

### Infrastructure
- ✅ PostgreSQL + TypeORM
- ✅ Swagger sur `/api`
- ✅ Docker Compose local (`toolbox/docker-compose.yml`)
- ✅ Variables d'environnement via `@nestjs/config`
- ✅ CI/CD GitHub Actions (`publish-image.yml`, `code-quality.yml`, `postman-tests.yml`)
- ✅ Image Docker multi-stage, user `node` non-root
- ✅ Sessions par device (UserSessionEntity, rotation refresh token)

### Sprint hotfix-v0-10-1 (2026-06-12)
- ✅ **[US-1 RGPD — 2026-06-12]** `RegisterDto.name` : validation stricte `@Matches` (3-32 chars, `@` interdit). `username.helper.ts` (NEW) : sanitisation depuis email, anti-collision. `googleStrategy` : username dérivé de `displayName` Google ou part locale email — jamais l'email complet. `displayName` rempli à la création. DTOs publics (`comments`, `friends`, `public-profile`) : `stripEmailFormat` en defense-in-depth. Logs d'emails retirés de `googleStrategy`. Migration `1749600000000-SanitizeEmailUsernames` : backfill `displayName` + réécriture des usernames au format email (part locale + suffixe anti-collision RETRO-006 unicité LOWER).
- ✅ **[US-2 Cover stream — 2026-06-12]** `CoverProxyService.streamCover()` : serve bytes depuis cache disque `COVERS_CACHE_DIR`, fetch upstream avec User-Agent navigateur, write disque, fallback 302 si échec. `manga-covers.controller.ts` : param `?mode=stream` → 200 bytes, sinon 302 actuel. Volume Docker `manga-tracker-covers` dans `ci-cd.yml` et `compose.production.yml`.
- ✅ **[US-3 Refresh 90d — 2026-06-12]** `JWT_REFRESH_SECRET_EXPIRES_IN` : 7d → 90d dans `ci-cd.yml` (job deploy) et `compose.production.yml` (default `:-90d`).
- ✅ **[US-4 Cache recos — 2026-06-12]** `RecoCacheService` (in-memory, TTL 1h, `MAX_ENTRIES=5000`, invalidation ciblée O(k) par user) + `RecoCacheModule` (micro-module autonome sans dépendance — casse le cycle `LibraryModule→RecommendationModule→MangasModule→LibraryModule` qui crashait le bootstrap). `RecommendationService` : wrap cache sur `buildUserRecommendations`/`buildUserRecommendationsByGenre`. `LibraryService` : `invalidateUser` sur toute mutation. Caps `MAX_RECOS_PER_SOURCE` 30→40, `ADAPTIVE_FALLBACK_CAP` 60→80.

---

## 🔴 À implémenter

### 🔒 Durcissement sécurité (PRIORITÉ HAUTE — voir known-issues.md)
- 🔴 **`synchronize: false`** en TypeORM + créer migrations rétroactives
- 🔴 **Retirer secrets versionnés** (`development.env`) + rotation des clés (JWT_KEY, JWT_REFRESH_SECRET, GOOGLE_CLIENT_SECRET) + ajouter `*.env` au `.gitignore` (sauf `template.env`)
- 🔴 **Installer `helmet`** + appliquer dans `main.ts`
- 🔴 **Installer `@nestjs/throttler`** + global + renforcé sur `/auth/login`, `/auth/register`, `/auth/refresh`
- 🔴 **CORS whitelist explicite** par env (`CORS_ORIGINS`) — préparer le front web futur
- 🔴 Scripts `migration:generate` / `migration:run` / `migration:revert` dans `package.json`
- 🔴 Migration:run dans la pipeline CI/CD avant déploiement

> Voir `.claude/skills/secure-deployment/SKILL.md` pour le workflow complet.

### Court terme
- ✅ ~~Endpoint proxy pour les images MangaUpdates (CORS)~~ — résolu par US-2 (mode=stream, cache disque)
- 🔴 Traduction des champs manga (titre, description) selon la langue utilisateur
- 🔴 Historique de recherche utilisateur
- 🔴 Confirmation e-mail

### Moyen terme
- 🔴 Système de notifications (nouvelles sorties)
- 🔴 Cache Redis + BullMQ
- 🔴 Notes et avis utilisateurs
- 🔴 Statistiques utilisateur (chapitres lus, temps, streak)
- 🔴 Calendrier des sorties
- 🔴 Tests unitaires étendus sur `auth/`

### Long terme
- 🔴 Recommandations personnalisées (LightFM via FastAPI)
- 🔴 Espace communautaire
- 🔴 Versioning API (`/v1/...`)
- 🔴 Rotation des secrets JWT (mécanisme `kid`)

---

## 🗂️ Catalogue MangaUpdates — découpage par année (2026-08-28)

Branche `feat/catalog-sharding-by-year` (dépend de la PR #74).

**Bug corrigé** : `CATALOG_SYNC_MAX_PAGES` (50) servait de plafond absolu de pagination — la passe s'arrêtait page 50, se déclarait terminée, remettait le curseur à 0 et réingérait éternellement les mêmes ~5 000 titres. La variable est désormais **dépréciée et ignorée**.

**Découpage** : `total_hits` de `/series/search` est plafonné à 10 000 par requête. Une passe par année (`catalog:year:<AAAA>`, année courante → 1930) ramène chaque requête sous ce plafond. Sous-découpage par genre si une année sature, récursion limitée à 2 niveaux.

**Reprise inter-shards** : une ligne `catalog_sync_state` par shard, curseur jamais réinitialisé globalement. La file exclut les shards terminés encore frais → une nuit reprend là où la précédente s'est arrêtée. Rafraîchissement 30 j (7 j pour les passes globales et les 2 années les plus récentes).

**Découpage du code** : `catalog-sync.service.ts` (468 l.) → orchestration seule (400 l.) + `CatalogShardPlannerService` (planification pure), `CatalogPageIngestService` (MU + backoff + upsert), `CatalogHydrationService`.

**Résultat négatif à ne pas ré-investiguer** : le payload `/series/search` **ne contient pas** `associated` (titres alternatifs). Ils ne sont alimentables que par `getMangaDetails` — d'où 117 mangas sur 5 055 seulement.

---

## 📥 Sorties récentes + titres alternatifs (2026-08-29)

Branche `feat/releases-et-titres-alt` (part de `feat/catalogue-et-recos`).

**JOB 1 — sorties** (`CatalogReleasesService`, cron 02:00) : lit `POST /v1/releases/search` de façon incrémentale et fait monter `manga.total_chapters` en `GREATEST` (invariant A-5). Attaque la cause du « MangaUpdates est en retard sur le nombre de chapitres » : le total n'était alimenté que par l'ouverture d'une fiche ou un signalement, donc uniquement sur les titres déjà consultés. Curseur temporel `catalog_sync_state.cursor_time_added`, qui **n'avance que sur un run intégralement réussi** (parcours récent → ancien : avancer après un échec enterrerait les sorties non traitées). Aucune création de série — la découverte reste le métier du catalogue.

**À ne pas re-sonder — sémantique MU vérifiée le 2026-08-29** :
- `record.id` de `/releases/search` **n'est PAS le `series_id`** : c'est l'id de la SORTIE (7 chiffres) ; les `series_id` en ont 11, et `GET /v1/series/<release_id>` répond 404. Le vrai id n'arrive qu'avec **`include_metadata: true`**, sous `metadata.series.series_id`.
- `time_added` est un **objet** `{timestamp, as_rfc3339, as_string}`, pas une chaîne.
- `orderby` ∈ `{date, time, title, vol, chap}` — `time` est strictement décroissant. `release_date` est **inexploitable** (dates aberrantes `0001-07-05`, `1111-11-11` en base MU).
- Volume : **267 sorties/jour** → 3 pages de 100 par nuit. `perpage: 100` OK, `total_hits` plafonné à 10 000.

**JOB 2 — titres alternatifs** : le service d'hydratation EXISTANT est étendu (`associated IS NULL` ajouté au critère), **pas de second service**. `/v1/series/{id}` ramène déjà `associated` dans la même réponse que genres/rating/année — un job dédié aurait tapé deux fois la même fiche. Priorisation bibliothèque utilisateur > recommandation > reste du catalogue.

**Dimensionnement** : 131 185 fiches × 2 s ≈ 73 h. À `CATALOG_SYNC_HYDRATION_BUDGET` = 800 (défaut) → 164 nuits ; à 2 000 → 66 nuits (67 min/nuit). Le rythme (1 req / 2 s) ne bouge jamais, seul le nombre de fiches par nuit est ajustable.

**Bug corrigé au passage** : `getMangaDetails` écrivait `associated` sans condition alors que le DTO le remplit avec `[]` quand MU ne renvoie rien — une fiche pouvait **perdre** ses titres alternatifs. Désormais null-safe (`buildAssociatedUpdate`).

**Politique réseau** : backoff extrait dans `mu-backoff.ts` et partagé par les deux jobs. Sorties 02:00, catalogue 03:30 → jamais simultanés (90 min de marge pour un pire cas de 26 min).

---

## 🐛 Problèmes connus

Voir [.claude/memory-bank/known-issues.md](known-issues.md) — 5 problèmes actifs détectés à l'audit sécurité de mai 2026.

---

## 📈 Progression globale

**≈ 50% du MVP** — Socle technique solide (auth, mangas, bibliothèque). Sécurité production à durcir avant exposition publique.
Prochaines priorités : durcissement sécurité, traduction des champs, proxy images, notifications, cache Redis.
