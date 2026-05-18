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
- 🔴 Endpoint proxy pour les images MangaUpdates (CORS)
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

## 🐛 Problèmes connus

Voir [.claude/memory-bank/known-issues.md](known-issues.md) — 5 problèmes actifs détectés à l'audit sécurité de mai 2026.

---

## 📈 Progression globale

**≈ 50% du MVP** — Socle technique solide (auth, mangas, bibliothèque). Sécurité production à durcir avant exposition publique.
Prochaines priorités : durcissement sécurité, traduction des champs, proxy images, notifications, cache Redis.
