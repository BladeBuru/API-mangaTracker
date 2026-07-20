# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.
Format : [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/) · Versioning : [SemVer](https://semver.org/lang/fr/).

---

## [Unreleased] — feat/recos-chapitres-traductions

### Added
- **library** : `POST /library/:muId/report-chapters` — signalement « plus de chapitres » par user (Chantier A) : upsert `manga_chapter_report`, total effectif = `max(total officiel, reported_total)`, consolidation communautaire ≥ 2 users distincts (MIN des concordants, écriture GREATEST sur `manga.total_chapters`)

### Changed
- **library** : `PUT /library/chapter` — cap 406 s'applique au total effectif `max(total_chapters, report user)` et non plus au total officiel seul ; backfill transactionnel du journal `user_manga_chapter_log` (chapitres oldRead+1..newRead, cap 500 derniers, dédup 10 min du chapitre terminal, décrément = no-op) dans la même transaction que le pointeur (fallback séquentiel best-effort)
- **library** : `GET /library/all` — `totalChapters` expose le total effectif + nouveau champ optionnel `userReportedTotalChapters` dans `MangaQuickViewDto`
- **library / mangas** : écriture GREATEST inconditionnelle sur `manga.total_chapters` dans `checkManga` (refresh 6 h) ET `getMangaDetails` (invariant A-5 : monotone croissant, la regex MU sous-estime le vrai total — voir memory-bank/decisions.md)
- **library** : `POST /library/:muId/chapter-log` — fenêtre d'idempotence 10 min : une lecture identique (user, manga, chapitre, non-skippée) < 10 min réutilise la ligne existante

### BDD
- Migration `1753100000000-CreateMangaChapterReport` : nouvelle table `manga_chapter_report` (FK user CASCADE + manga CASCADE, index unique `(user_id, manga_id)`, index `manga_id`)

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
