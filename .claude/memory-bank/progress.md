# Progrès — Manga Tracker API

> Dernière mise à jour : Septembre 2026

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
- ✅ **[Reprise de lecture inter-appareils — 2026-09-06]** `PUT /library/reading-position` (`{ muId, chapter, positionPercent }` → `{ ok: true }`) et `GET /library/:muId/reading-position` (`{ chapter, positionPercent, updatedAt }` ou **204**). État « lecture EN COURS » porté par `user_manga.current_chapter` / `current_position_percent` / `current_position_updated_at` (migration `1788393600000`), **un pourcentage et non des pixels** (la hauteur d'un chapitre dépend de l'écran). Distinct de `user_read_chapters` (dernier chapitre TERMINÉ), jamais écrasé par cette route ; la position est invalidée dans le MÊME UPDATE que le pointeur quand le chapitre en cours est terminé. Champs aussi exposés en optionnel par `GET /library/all`. `user_manga_chapter_log.scrollPosition` volontairement NON réutilisée : journal additif de chapitres terminés (N lignes par chapitre), alors qu'un état « en cours » est un singleton par (user, manga). Détails dans `docs/specs/library/spec-technique.md`
- ✅ **[Bascule auto « à jour » → « en cours » — 2026-09-05]** `ReadingStatusAutoUpdateService.flipCaughtUpToReading(muId)` : quand `manga.total_chapters` **augmente**, toutes les entrées `caughtUp` du manga dont `user_read_chapters < total` passent `reading` (`lastUpdated` mis à jour) en **une requête ensembliste**. Branché sur `CatalogReleasesService.applyUpdates`, `ChapterReportService.consolidate`, `MangasService.getMangaDetails`. Détails ci-dessous

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

## 🧭 Type de publication, recos au prorata, accueil façon Netflix (2026-09-05)

Branche `feat/manga-type-recos-home` (base `master` d7fd6fd).

**Bug corrigé** : les recommandations servaient exclusivement des mangas à des lecteurs de manhwa — la table `manga` n'avait aucune colonne de type. Mesuré en prod (77 titres en bibliothèque, ids masqués) : 73 % Manhwa, 13 % Manhua, 10 % Manga.

**Colonne `manga.type`** (migration `1788220800000`, `varchar(32)` NULL + index type/year/rating) — colonne protégée (`PROTECTED_NULLABLE_COLUMNS`) écrite sur tous les chemins : upsert catalogue (`record.type` est dans le payload `/series/search`), `getMangaDetails`, `MangaSyncService`, `Manga.fromMU`.

**Rattrapage** (`CatalogTypeBackfillService`) : volet A au démarrage (+60 s) — fiches des titres en bibliothèque sans type ; volet B cron 01:00 — `/series/search` filtré Manhwa puis Manhua par année décroissante, curseur `type:<T>:year:<AAAA>`, budget 200 pages/nuit, disjoncteur. **Pas de défaut « Manga »** : le catalogue nightly persiste la vraie valeur sur chaque ligne revisitée (≤ 30 j) ; NULL = inconnu, pénalisé par les recos. `MuJobLockService` = un seul job MU à la fois ; `CatalogShardRunnerService` = passe de shard partagée catalogue/rattrapage.

**Recos** (`type-profile.ts`) : profil pondéré (statut × note) → `interleaveByTypeMix` (round-robin à déficit : tout préfixe ≈ parts du profil, jamais zéro) sur `/recommendations`, `/by-genre`, `/sleepers` + candidats catalogue par bucket de type. `recommendation.service.ts` 889 → 526 lignes (`SleeperHitsService`, `RecommendationDtoBuilderService`).

**Accueil** : `GET /mangas/home/sections?limit=` et `/mangas/home/sections/:id?page=&limit=` — BDD seule, cache 10 min SWR, dédup inter-sections avec lecture progressive, sections < 5 omises. Règles dans `home-sections.query.ts`. Contrat vérifié par `npm run verify:home-contract`.

**À surveiller après déploiement** : (1) logs `[type-backfill]` au boot (≈ 80 fiches, ~3 min) ; (2) les sections `type:*` de l'accueil apparaissent dès que ≥ 5 titres typés ; (3) `hidden_gems` chevauche `popular` sur les pages de détail tant que le graphe `manga_recommendation` est maigre (12 k liens) — la dédup de l'accueil règle le cas sur la home.

**Non fait** : smoke test HTTP local (pas de PostgreSQL local ni Docker) — SQL des sections validé en lecture seule sur la prod (3-216 ms par section sans les nouveaux index).

## 🔁 Bascule auto « à jour » → « en cours » (2026-09-05)

Branche `feat/auto-status-en-cours` (base `d7fd6fd`). Pendant Flutter : même nom de branche.

**Règle produit** : *« si on détecte un nouveau chapitre sur un manga que j'ai marqué "à jour", c'est qu'on n'est plus à jour : on est "en cours" »*. Lu jusqu'au 39, « à jour » ; le 40 paraît → « en cours ».

**Valeurs de statut (vérifiées en prod)** : « à jour » = `caughtUp`, « en cours » = `reading`. Distribution prod : reading 65 · readLater 9 · caughtUp 7 · completed 6. Pas de statut « abandonné » / « en pause » dans l'app.

**Service** : `src/api/library/reading-status-auto-update.service.ts` — `flipCaughtUpToReading(muId)`, UPDATE ensembliste `manga_id = X AND "readingStatus" = 'caughtUp' AND user_read_chapters < (SELECT total_chapters FROM manga …)`, retourne `affected`, log `Logger`, best-effort (erreur BDD → `Logger.error` + 0). Plan vérifié en prod par `EXPLAIN` (index `idx_user_manga_manga_id`). Déclaré dans `LibraryModule` (exporté) **et** re-déclaré dans `MangasModule` (même doctrine que `ChapterReportService` : forwardRef croisé, stateless).

**Points de branchement** (= tous les écrivains de `total_chapters`) :
1. `CatalogReleasesService.applyUpdates` — garde `.andWhere('total_chapters < :newTotal')` sur le GREATEST → `affected > 0` ⇔ hausse → flip. Compteur `statusFlips` dans `ReleasesSyncOutcome` + log.
2. `ChapterReportService.consolidate` — même garde, flip si `affected > 0`.
3. `MangasService.getMangaDetails` — pré-lecture `readCurrentTotal(muId)` (SELECT `total_chapters` par `mu_id`), flip si `newTotal > previousTotal`. Couvre `LibraryService.checkManga` (refresh 6 h — son propre GREATEST reçoit le même total, commenté), `UpdateMangaService` et `MangaSyncService`.

**Décisions** :
- **Hausse effective uniquement** (pas « état incohérent ») : un lecteur volontairement « à jour » en retard sur MU (scans FR vs raws) ne doit pas être ramené en boucle à « en cours » toutes les 6 h. Conséquence : les 3 lignes prod déjà en retard (22/26/58 chapitres) basculeront à la prochaine parution, pas au déploiement. Pas de migration de données.
- Seul `caughtUp` bascule ; `completed` et `readLater` intouchés. Réciproque `updateChapter` → `caughtUp`/`completed` inchangée.
- Best-effort : la bascule ne fait jamais échouer l'appelant.

**Tests** : +15 (282 → 297) — `reading-status-auto-update.service.spec.ts` (6), `catalog-releases.service.spec.ts` (+3), `chapter-report.service.spec.ts` (+2), `mangas.service.spec.ts` (+4).

**Reste à faire** : déployer l'API **avant** l'app ; observer le log `[releases] … N statut(s) « à jour » → « en cours »` après le premier cron.

---

## 🤝 Signal de lecture public MangaUpdates — collecte anonymisée (2026-09-09)

> Branche `feat/reader-signal-collect`. **Aucune route exposée, moteur de recommandation NON modifié.** Le livrable s'arrête à la donnée collectée et agrégée.

#### Pourquoi

Relevé en prod le 2026-09-09 : **6 comptes, 87 lignes de bibliothèque, 4 notes, 0 rejet**. Aucun filtrage collaboratif n'est possible là-dessus. MangaUpdates expose des listes de lecture **publiques** dont les `series_id` **sont déjà nos `mu_id`** — aucune table de correspondance à construire.

#### Ce qui est fait

- ✅ **3 tables** (migration `1788566400000`, additive et idempotente) : `reader_signal` (brut pseudonymisé, unicité `user_hash` + `mu_id` + `list_type`), `reader_profile` (fenêtre de rafraîchissement), `reader_cooccurrence` (agrégats œuvre↔œuvre, index `(mu_id_a, score DESC)`)
- ✅ **Job de collecte** `ReaderSignalCollectService` — cron **05:30** + jitter, budget 1 000 requêtes/nuit, verrou MU partagé, backoff `mu-backoff.ts`, disjoncteur, curseurs dans `catalog_sync_state`
- ✅ **Job d'agrégation** `ReaderSignalAggregateService` — cron **06:30**, purement local (aucune requête réseau), recalcul intégral en une transaction
- ✅ **Pseudonymisation fail-closed** `ReaderHashService` — HMAC-SHA256 salé, sans sel valide rien n'est écrit et aucun appel réseau n'est fait
- ✅ **138 tests** ajoutés (412 → 550), 9 suites

#### Créneaux MU et partage du quota

| Heure | Job | Budget |
|---|---|---|
| 01:00 | `CatalogTypeBackfillService` (type) | 200 pages |
| 02:00 | `CatalogReleasesService` (sorties) | ~3 pages en régime établi |
| 03:30 | `CatalogSyncService` (catalogue) | 60 pages |
| ~04:00 | Hydratation | 800 appels détail |
| **05:30** | **`ReaderSignalCollectService`** | **1 000 requêtes ≈ 33 min** |
| 06:30 | Agrégation des co-occurrences | **0 requête MU** |

05:30 laisse 90 min de marge après l'hydratation et finit vers 06:05 au pire. Le job nocturne de la session parallèle (graphe de recommandations) prendra un autre créneau ; en cas de chevauchement, le **verrou `MuJobLockService` partagé** fait sauter le run perdant — les curseurs sont persistés, rien n'est perdu, la reprise se fait au créneau suivant. Débit global inchangé : **1 requête / 2 s, un seul job MU à la fois**.

#### Rendement mesuré (sonde réelle du 2026-09-09)

- **Découverte** : 43,9 lignes de signal et 35,5 lecteurs uniques **par requête** (15 requêtes sur les 3 premières cibles du seau bibliothèque → 659 lignes, 532 lecteurs, 21 % notées)
- **Extraction** : 4,38 requêtes par lecteur (1 `GET /lists/public` + 3,38 listes en moyenne), 0 compte sans liste publique sur l'échantillon
- Projection à budget par défaut (400 découverte / 600 extraction) : **~17 500 lignes/nuit de découverte + ~137 lecteurs extraits**, soit plusieurs dizaines de milliers de lignes par nuit

#### Comment brancher le moteur de recommandation (chantier suivant)

`reader_cooccurrence` est conçue pour être lue **sans jointure et sans `OR`** — les deux sens de chaque paire sont stockés :

```sql
-- Voisines d'une œuvre, meilleures d'abord (index IDX_reader_cooccurrence_a_score)
SELECT mu_id_b, score, co_readers
  FROM reader_cooccurrence
 WHERE mu_id_a = $1
   AND co_readers >= 5          -- seuil de confiance à régler côté moteur
 ORDER BY score DESC
 LIMIT 20;
```

Points d'attention pour l'intégration :
1. **`score < 0` est exploitable tel quel comme MALUS** (« les lecteurs qui aiment A abandonnent B ») — c'est le signal négatif qui manque au produit, ne pas le filtrer par un `score > 0` réflexe
2. **`co_readers` est l'indicateur de confiance**, indépendant du score : un 0,9 sur 3 lecteurs ne vaut pas un 0,6 sur 400. Pondérer, ou seuiller
3. Pour un profil complet, sommer les voisines de toute la bibliothèque de l'utilisateur en pondérant par son propre engagement, puis exclure ce qu'il a déjà et ce qu'il a écarté (`user_manga_dismissal`)
4. Le prorata par type (`interleaveByTypeMix`) reste applicable **après** ce scoring — la co-occurrence ne remplace pas la composition, elle alimente le pool de candidats
5. `ReaderSignalAggregateService` est **exporté** par `ReaderSignalModule` : le moteur peut déclencher un recalcul sans dépendre du cron

#### Conformité — points restant à trancher (juridique, hors compétence de cette session)

Ce qui est **traité par la conception** : pseudonymisation avant écriture, aucun champ identifiant persisté ni loggé, minimisation (5 colonnes), chemin d'anonymisation par agrégation, purge des lignes brutes outillée, cadence et cache respectueux de MangaUpdates.

Ce qui reste à **faire valider par un juriste**, avant toute exploitation en production :

1. **Base légale.** L'intérêt légitime (art. 6.1.f) est le candidat naturel, mais il exige un **test de mise en balance documenté** : finalité, nécessité, et attentes raisonnables des personnes concernées — des lecteurs MangaUpdates qui n'ont jamais entendu parler de Manga Tracker. À écrire et à conserver.
2. **Information des personnes concernées** (art. 14, collecte indirecte). En pratique impossible à notifier individuellement ; l'article 14.5.b prévoit une exemption pour effort disproportionné, mais elle **doit être motivée** et compensée par une information publique — section dédiée dans `legal/PRIVACY_POLICY.md`, à rédiger.
3. **Données sensibles (art. 9).** Une liste de lecture peut révéler indirectement une orientation sexuelle (BL/yaoi). Trancher : la pseudonymisation suffit-elle, ou faut-il exclure certains genres de la collecte ? Le filtre NSFW existant réduit l'exposition mais ne la supprime pas.
4. **Durée de conservation.** Fixer une valeur pour `READER_SIGNAL_RAW_TTL_DAYS` (90 jours est un point de départ raisonnable) et l'activer une fois la pondération stabilisée. Aujourd'hui à `0` = pas de purge.
5. **Droits des personnes** (accès, effacement, opposition). Sans identifiant en clair, retrouver un lecteur suppose de re-calculer son hash depuis un `user_id` fourni — techniquement possible, procédure à écrire. Décider aussi ce qu'on répond à une demande visant des agrégats déjà calculés.
6. **Registre des traitements** (art. 30) : inscrire ce traitement, ses finalités, ses catégories de données et sa durée de conservation.
7. **AIPD** (art. 35) : évaluer si elle est requise — traitement à grande échelle de données pouvant révéler des données sensibles, personnes non informées. À trancher, pas à supposer.
8. **Conditions d'utilisation de MangaUpdates** : vérifier que la collecte automatisée de listes publiques y est admise, et à quelles conditions (attribution, cadence).

**Tant que ces points ne sont pas tranchés**, le job peut rester désactivé (`READER_SIGNAL_ENABLED=false`, ou simplement pas de `READER_SIGNAL_HASH_SALT` : le fail-closed suffit).

#### Requête SQL de bilan (à jouer après quelques nuits)

Répond à « est-ce que ce chemin produit assez de signal sur le manhwa/manhua ? » :

```sql
SELECT COALESCE(m.type, 'inconnu')                        AS type_oeuvre,
       COUNT(*)                                           AS lignes,
       COUNT(DISTINCT s.user_hash)                        AS lecteurs,
       COUNT(DISTINCT s.mu_id)                            AS oeuvres,
       ROUND(100.0 * COUNT(s.rating) / COUNT(*), 1)       AS pct_notees,
       COUNT(*) FILTER (WHERE s.list_type = 'complete')   AS complete,
       COUNT(*) FILTER (WHERE s.list_type = 'read')       AS en_cours,
       COUNT(*) FILTER (WHERE s.list_type = 'wish')       AS souhaits,
       COUNT(*) FILTER (WHERE s.list_type IN ('unfinished','hold')) AS negatifs
  FROM reader_signal s
  JOIN manga m ON m.mu_id = s.mu_id
 GROUP BY 1
 ORDER BY lignes DESC;

-- Couverture des agrégats par type (ce que le moteur pourra réellement servir)
SELECT COALESCE(m.type, 'inconnu')                     AS type_oeuvre,
       COUNT(DISTINCT c.mu_id_a)                       AS oeuvres_avec_voisines,
       COUNT(*)                                        AS paires,
       COUNT(*) FILTER (WHERE c.score < 0)             AS paires_negatives,
       ROUND(AVG(c.co_readers), 1)                     AS lecteurs_communs_moyen
  FROM reader_cooccurrence c
  JOIN manga m ON m.mu_id = c.mu_id_a
 GROUP BY 1
 ORDER BY paires DESC;

-- Progression nuit après nuit
SELECT DATE(collected_at) AS nuit, COUNT(*) AS lignes,
       COUNT(DISTINCT user_hash) AS lecteurs
  FROM reader_signal GROUP BY 1 ORDER BY 1 DESC LIMIT 14;
```

## 🕸️ Graphe de recommandations œuvre-à-œuvre MangaUpdates (2026-09-09)

Branche `feat/reco-graph-mu` (base `master` `0c32a8c`).

**Le constat.** `GET /v1/series/{id}` renvoie TROIS voisinages et un seul était ingéré — le moins pertinent. Mesuré sur Solo Leveling (`15180124327`, Manhwa) : `recommendations` (manuel, poids 2-3) → *Kimetsu no Yaiba*, *Vinland Saga* (des mangas japonais sans rapport) ; `category_recommendations` (votes de catégorie, poids 27 000-38 000) → *Solo Leveling: Ragnarok*, *I Am the Final Boss*, *I Am the Sorcerer King* (le bon voisinage) ; `related_series` → suites et spin-offs avec `relation_type`. En prod : **17 825 liens sur 3 812 séries** (2,6 % de 147 261 titres), cibles à 84 % `Manga`, et **12 titres sur 77** en bibliothèque avaient un lien sortant.

**Modèle** (migration `1788480000000`) : `manga_recommendation.kind` (`manual` | `category` | `related`, défaut `manual` — les 17 825 liens existants sont marqués par un UPDATE explicite), `relation_type varchar(48)`, unicité `(source_mu_id, kind, recommended_mu_id)` (une paire peut exister sous plusieurs origines ; poids non comparables entre origines), `manga.reco_graph_attempted_at` (filigrane du rattrapage). Une colonne plutôt que trois tables : même forme, mêmes consommateurs, une seule requête par source.

**Ingestion à coût réseau nul** : `RecoGraphIngestService` reçoit une réponse `/series/{id}` DÉJÀ téléchargée. Branché sur `MangasService.getMangaDetails` — donc aussi sur les 800 fiches/nuit de `CatalogHydrationService`, qui l'appelle en boucle — et sur `fetchAndCacheRecommendations`. Écrit au passage le `type` de la série source (null-safe) : c'est lui qui alimente le prorata de type.

**Rattrapage** : `RecoGraphBackfillService`, cron **07:00 + jitter 0-10 min**, budget `RECO_GRAPH_BACKFILL_PAGES_PER_RUN` (1 500 fiches ≈ 50 min). Priorité bibliothèques → cibles déjà recommandées → éligibles à l'accueil → mieux notées. Verrou MU partagé, backoff `mu-backoff.ts`, disjoncteur à 5 échecs consécutifs, état dans `catalog_sync_state` (`reco-graph`). Créneau choisi pour éviter **05:30 / 06:30**, occupés par un chantier parallèle (collecte de listes de lecteurs MU puis agrégation).

**Exploitation** : `RecoGraphCandidateService` + `reco-graph-scoring.ts`. Les voisins des œuvres appréciées (statut fort ou note ≥ 7) entrent dans le pool ; poids `category` normalisés **relativement à la source** (`w / wmax` × 30, calibré entre la moyenne des poids `manual` (12) et leur maximum (220)) ; `related` réservés aux sources terminées/à jour, hors relations « même œuvre, autre support », contribution forfaitaire 10. Contributions **additives** (contrairement au complément catalogue), exclusion biblio ∪ rejets, prorata de type inchangé. Garde-fou : `getCachedRecommendations` filtre `kind = 'manual'` — sans ça les poids de catégorie écraseraient tout le scoring historique.

**Effet mesuré** (prod, lecture seule, `npm run measure:reco-graph`) — utilisateur principal, 68 titres, profil 74,6 % Manhwa : pool **218 → 390** candidats ; **origine des 30 cartes servies : 23 catalogue local + 7 liens manuels → 24 graphe MU + 4 manuels + 2 catalogue** ; **25/30 titres renouvelés**. Le prorata de type tenait déjà le format (66,7 % → 63,3 % de manhwa) ; ce qui change, c'est la **pertinence** — on passe d'une heuristique « même genre, bien noté » à un vrai voisinage œuvre-à-œuvre.

**Tests** : +56 (412 → 468), 5 suites ajoutées.

**Reste à faire** : (1) déployer et observer les logs `[reco-graph]` après le premier cron 07:00 (budget consommé, liens écrits, éligibles restants) ; (2) relancer `npm run measure:reco-graph -- --db` après quelques nuits pour confirmer sur les données réellement ingérées ; (3) côté Flutter, afficher le **crédit MangaUpdates** sous les listes de recommandations (leur politique d'usage le demande) ; (4) surveiller la volumétrie de `manga_recommendation` : ~13 liens par fiche, soit ~1,9 M de lignes (**≈ 350 Mo**) si l'on couvre les 147 261 séries (≈ 98 nuits). Pour la borner, baisser `RECO_GRAPH_BACKFILL_PAGES_PER_RUN` ou restreindre le rattrapage aux rangs 0-2 (le rang 3 « reste du catalogue » est le seul qui pousse le volume).

---

## 🐛 Problèmes connus

Voir [.claude/memory-bank/known-issues.md](known-issues.md) — 5 problèmes actifs détectés à l'audit sécurité de mai 2026.

---

## 📈 Progression globale

**≈ 50% du MVP** — Socle technique solide (auth, mangas, bibliothèque). Sécurité production à durcir avant exposition publique.
Prochaines priorités : durcissement sécurité, traduction des champs, proxy images, notifications, cache Redis.
