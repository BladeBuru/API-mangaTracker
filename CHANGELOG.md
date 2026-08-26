# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.
Format : [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/) · Versioning : [SemVer](https://semver.org/lang/fr/).

---

## [Unreleased] — fix/recos-by-genre-dedup

### Fixed
- **recommendations** : `GET /recommendations/by-genre` — toutes les sections affichaient les mêmes titres (certains en triple) car chaque manga du pool était poussé dans TOUTES les sections de ses genres, sans dédup ni complément. Fix : dédup par `mu_id`, exclusivité inter-sections (un manga n'apparaît que dans la section de son genre le mieux classé — genres favoris de la biblio, fallback représentation pool), complément des sections sous `perGenre` par le catalogue local (rating ≥ 7, NSFW exclus, hors biblio, hors titres déjà affichés — 1 requête max par section, pas de N+1). Logique extraite dans `GenreSectionService` (contrat de réponse `Map<genre, MangaQuickViewDto[]>` inchangé) + 10 tests unitaires dédiés

### Changed (corrections revue adversariale — commit d8641f4)
- **library** : throttle `POST /library/:muId/report-chapters` par userId (10/h) via `UserThrottlerGuard` au lieu du throttle global par IP — le reverse proxy NPMplus masque les IPs clients
- **library** : dédup 10 min `chapter-log` — la fenêtre met désormais à jour `scrollPosition` et `isBonus` de la ligne récente au lieu de l'ignorer silencieusement
- **mangas** : `getRecommendationsForManga` intercepte `MuRateLimitException` (429 MU) et retourne `[]` — dégradation gracieuse, plus de 429 propagé au client
- **mangas** : `buildCatalogUpsertBatches` (`catalog-sync.mapper.ts`) — lots séparés par colonnes non-null ; `rating`, `year`, `covers` jamais écrasés par null
- **mangas** : erreurs DB dans `runCatalogPass` (`catalog-sync.service.ts`) → statut `partial` + `consecutive_failures++` sans sauter la passe (l'ancien comportement ne mettait pas à jour l'état)
- **mangas** : `DescriptionTranslationService` — stale-while-revalidate sur hash mismatch (description MU mise à jour) + negative-cache 5 min sur échec provider

### CI
- Injection optionnelle de `DEEPL_API_KEY` (secret `PROD_DEEPL_API_KEY`) dans le compose NAS via `ci-cd.yml` (commit 1627558)

---

## [Unreleased] — feat/recos-chapitres-traductions

### Added
- **library** : `POST /library/:muId/report-chapters` — signalement « plus de chapitres » par user (Chantier A) : upsert `manga_chapter_report`, total effectif = `max(total officiel, reported_total)`, consolidation communautaire ≥ 2 users distincts (MIN des concordants, écriture GREATEST sur `manga.total_chapters`)
- **mangas** : traductions serveur des descriptions — table `manga_translation` (cache par `(mu_id, language)`, invalidation par `source_hash` sha256), `DescriptionTranslationService` (providers DeepL si `DEEPL_API_KEY` sinon gtx, dédup in-flight, timeout 4 s + upsert en arrière-plan) ; `GET /mangas/:id` lit le header `Accept-Language` et renvoie le champ additif `translated_description` (en = passthrough)
- **mangas** : catalogue local nightly — `@nestjs/schedule`, `CatalogSyncService` (@Cron 03:30 + jitter) pagine les populaires MU (perpage 100, 2 s/appel, backoff 429 5/10/20/40 s, curseur de reprise `catalog_sync_state`, upsert sans écraser les genres, hydratation genres 200/nuit) → ~5000 titres avec genres
- **recommendations** : `CatalogCandidateService` — top-up des candidats par genres favoris depuis le catalogue local quand le pool MU < 150 (rating ≥ 7, NSFW exclus, biblio exclue, score fusionnable)

### Changed
- **recommendations** : fetch à froid — délai 1 s inter-batch + `MuRateLimitException` typée sur 429 (pause 5 s) ; suppression du relax adaptatif (no-op prouvé : `slice(40,80)` sur des tableaux de ~5-25) ; Swagger `limit` max 100 → 500 (aligné `MAX_LIMIT`)
- **library** : `PUT /library/chapter` — cap 406 s'applique au total effectif `max(total_chapters, report user)` et non plus au total officiel seul ; backfill transactionnel du journal `user_manga_chapter_log` (chapitres oldRead+1..newRead, cap 500 derniers, dédup 10 min du chapitre terminal, décrément = no-op) dans la même transaction que le pointeur (fallback séquentiel best-effort)
- **library** : `GET /library/all` — `totalChapters` expose le total effectif + nouveau champ optionnel `userReportedTotalChapters` dans `MangaQuickViewDto`
- **library / mangas** : écriture GREATEST inconditionnelle sur `manga.total_chapters` dans `checkManga` (refresh 6 h) ET `getMangaDetails` (invariant A-5 : monotone croissant, la regex MU sous-estime le vrai total — voir memory-bank/decisions.md)
- **library** : `POST /library/:muId/chapter-log` — fenêtre d'idempotence 10 min : une lecture identique (user, manga, chapitre, non-skippée) < 10 min réutilise la ligne existante

### BDD
- Migration `1753100000000-CreateMangaChapterReport` : nouvelle table `manga_chapter_report` (FK user CASCADE + manga CASCADE, index unique `(user_id, manga_id)`, index `manga_id`)
- Migration `1753200000000-CreateMangaTranslationTable` : nouvelle table `manga_translation` (index unique `(mu_id, language)`)
- Migration `1753300000000-CreateCatalogSyncState` : nouvelle table `catalog_sync_state` (curseur de pagination du cron catalogue)

---

## [Unreleased] — sprint hotfix-v0-10-1

### Added
- `GET /friends/:id/library` : bibliothèque d'un ami — 403 si l'amitié n'est pas acceptée (l'acceptation vaut consentement, RETRO-014) *(sprint social/stats)*
- `GET /user/stats` enrichi Stats v2 : `readingHistory` (20 dernières sessions du journal chapter_log), `chaptersPerWeek` (8 semaines), `genreCounts` (top 10 avec compteurs) — `topGenres` conservé pour compat
- `PUT /user/password` durci : `currentPassword` requis + révocation des sessions après changement *(sprint change-password, en cours de finalisation côté front)*
- `GET /mangas/:muId/cover?mode=stream` : sert les bytes de la cover (cache disque `COVERS_CACHE_DIR`, User-Agent navigateur, fallback 302) — fix CORS Flutter Web
- `RecoCacheService` + `RecoCacheModule` : cache in-memory user-level des recommandations (TTL 1h, MAX_ENTRIES 5000, invalidation sur mutation library) — micro-module autonome sans dépendance externe
- `username.helper.ts` : sanitisation des usernames (pattern, dérivation depuis email, anti-collision, `stripEmailFormat`)
- Volume Docker `manga-tracker-covers` dans le déploiement

### Changed
- `POST /mangas/search` : tri par **pertinence** MangaUpdates (suppression de `orderby: 'rating'` et du re-tri local qui faisaient disparaître les titres de niche, ex. « Shadow System ») ; `perpage` aligné sur `limit` (borné 1-100) ; nouveau param `page` → réponse enveloppe `{results, totalHits, page, perPage, hasMore}` (tableau nu sans `page`, rétrocompat clients ≤ 0.11.0) + 8 tests unitaires `searchManga`
- `JWT_REFRESH_SECRET_EXPIRES_IN` : 7d → 90d en production (standard apps de tracking média)
- `MAX_RECOS_PER_SOURCE` 30 → 40, `ADAPTIVE_FALLBACK_CAP` 60 → 80 (volume de recos insuffisant)
- `RegisterDto.name` : validation stricte (3-32 chars, `@` interdit → exclut le format email)
- Google OAuth : username dérivé du displayName/part locale email (jamais l'email complet), `displayName` rempli
- DTOs publics (comments, friends, public-profile, sharing) : `stripEmailFormat` en defense-in-depth

### Fixed
- 🚨 RGPD : des usernames contenaient l'adresse email de l'utilisateur, exposée publiquement (commentaires, profil, recherche d'amis)
- Logs d'emails retirés (googleStrategy, googleMobileLogin) — règle RGPD projet
- Cycle de modules au bootstrap NestJS : `LibraryModule → RecommendationModule → MangasModule → LibraryModule` cassé via `RecoCacheModule` autonome sans dépendance

### Removed

### BDD
- Migration `SanitizeEmailUsernames` : réécrit les usernames au format email (part locale + suffixe anti-collision, unicité LOWER() RETRO-006) + backfill `displayName` pour tous les comptes
