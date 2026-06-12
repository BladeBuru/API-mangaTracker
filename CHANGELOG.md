# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.
Format : [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/) · Versioning : [SemVer](https://semver.org/lang/fr/).

---

## [Unreleased] — sprint hotfix-v0-10-1

### Added
- `GET /mangas/:muId/cover?mode=stream` : sert les bytes de la cover (cache disque `COVERS_CACHE_DIR`, User-Agent navigateur, fallback 302) — fix CORS Flutter Web
- `RecoCacheService` : cache in-memory user-level des recommandations (TTL 1h, invalidation sur mutation library)
- `username.helper.ts` : sanitisation des usernames (pattern, dérivation depuis email, anti-collision, `stripEmailFormat`)
- Volume Docker `manga-tracker-covers` dans le déploiement

### Changed
- `JWT_REFRESH_SECRET_EXPIRES_IN` : 7d → 90d en production (standard apps de tracking média)
- `MAX_RECOS_PER_SOURCE` 30 → 40, `ADAPTIVE_FALLBACK_CAP` 60 → 80 (volume de recos insuffisant)
- `RegisterDto.name` : validation stricte (3-32 chars, `@` interdit → exclut le format email)
- Google OAuth : username dérivé du displayName/part locale email (jamais l'email complet), `displayName` rempli
- DTOs publics (comments, friends, public-profile) : `stripEmailFormat` en defense-in-depth

### Fixed
- 🚨 RGPD : des usernames contenaient l'adresse email de l'utilisateur, exposée publiquement (commentaires, profil, recherche d'amis)
- Logs d'emails retirés (googleStrategy, googleMobileLogin) — règle RGPD projet

### Removed

### BDD
- Migration `SanitizeEmailUsernames` : réécrit les usernames au format email (part locale + suffixe anti-collision, unicité LOWER() RETRO-006) + backfill `displayName` pour tous les comptes
