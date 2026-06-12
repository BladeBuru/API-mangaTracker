# Discovery — Manga Tracker API

> Fichier généré automatiquement par retro-scanner. Usage interne uniquement.
> Ce fichier sera supprimé à la fin de la Phase 1-bis.

## Stack identifiée

| Composant | Valeur |
|-----------|--------|
| Framework | NestJS 9 (module-based, Express platform) |
| Version   | `@nestjs/core` ^9.0.0, `@nestjs/common` ^9.0.0 |
| SGBD      | PostgreSQL (`pg` ^8.10.0) |
| ORM       | TypeORM ^0.3.15 — `synchronize: false`, migrations versionnées dans `src/migrations/` |
| Auth      | JWT Passport — AccessToken (court) + RefreshToken (rotation de session) + Google OAuth2 (web redirect + mobile idToken) |
| Validation | `class-validator` ^0.14.0 + `class-transformer` ^0.3.1, `ValidationPipe` global avec `whitelist` + `forbidNonWhitelisted` |
| Doc API   | Swagger (`@nestjs/swagger` ^6.3.0), désactivé en production, exposé sur `/api` |
| Tests     | Jest 29.5.0 + Supertest — specs unitaires (`*.spec.ts`) dans `src/`, e2e dans `test/` |
| Emails    | Nodemailer + Brevo SMTP relay, templates Handlebars (verify-email, reset-password) |
| Sécurité  | `helmet` ^8.1.0, `@nestjs/throttler` ^6.5.0 (100 req/min global, override sur auth) |

## Features identifiées

### 1. Auth
**Description :** Inscription/connexion locale (email + bcrypt) et Google OAuth2 (web redirect + mobile idToken). Gère la rotation de sessions JWT multi-appareils, le logout ciblé ou global, et l'auto-login post-vérification email / reset password.
**Fichiers principaux :**
- `src/api/user/auth/auth.service.ts`
- `src/api/user/auth/auth.controller.ts`
- `src/api/user/auth/auth.helper.ts`
- `src/api/user/auth/user-session.entity.ts`
- `src/api/user/auth/strategy/` (accessTokenStrategy, refreshTokenStrategy, googleStrategy)

### 2. Email transactionnel
**Description :** Envoi d'emails de vérification d'adresse et de réinitialisation de mot de passe via le relay Brevo/SMTP, avec templates Handlebars bi-langue (fr/en) et tokens à usage unique stockés dans `auth_token`.
**Fichiers principaux :**
- `src/api/user/auth/email/email.service.ts`
- `src/api/user/auth/email/email.controller.ts`
- `src/api/user/auth/email/auth-token.service.ts`
- `src/api/user/auth/email/auth-token.entity.ts`
- `src/api/user/auth/email/templates/` (verify-email.hbs, reset-password.hbs)

### 3. Profil utilisateur
**Description :** Gestion des données de profil (displayName, bio, avatarUrl, dateOfBirth, gender, isProfilePublic). L'avatar est stocké en colonne `text` pour accepter les data URLs base64 en attendant un pipeline multer/sharp.
**Fichiers principaux :**
- `src/api/user/user.entity.ts`
- `src/api/user/user.service.ts`
- `src/api/user/users.controller.ts`
- `src/api/user/dto/`

### 4. RGPD
**Description :** Conformité RGPD articles 15, 17 et 20 — résumé d'accès, export JSON portable, enregistrement du consentement CGU/Privacy avec versioning, vérification de re-consentement, et suppression de compte (cascade DB).
**Fichiers principaux :**
- `src/api/user/gdpr/gdpr.service.ts`
- `src/api/user/gdpr/gdpr.controller.ts`
- `src/api/user/gdpr/gdpr.module.ts`

### 5. Statistiques utilisateur
**Description :** Calcul agrégé des statistiques de lecture (mangas par statut, chapitres lus, top genres, estimation de temps de lecture basée sur une heuristique de 4 min/chapitre).
**Fichiers principaux :**
- `src/api/user/stats/stats.service.ts`
- `src/api/user/stats/stats.controller.ts`
- `src/api/user/stats/stats.dto.ts`
- `src/api/user/stats/stats.module.ts`

### 6. Bibliothèque (Library)
**Description :** Ajout, suppression et gestion de la collection personnelle de mangas — statut de lecture (enum : reading, completed, caughtUp, readLater, dropped), compteur de chapitres, note utilisateur, lien personnalisé.
**Fichiers principaux :**
- `src/api/library/library.service.ts`
- `src/api/library/library.controller.ts`
- `src/api/library/reading-status.enum.ts`
- `src/api/library/user-manga-chapter-log.entity.ts`
- `src/api/library/chapter-log.service.ts`

### 7. Mangas (catalogue + sync MangaUpdates)
**Description :** Recherche, détail et tendances via l'API MangaUpdates. Les mangas sont mis en cache localement (table `manga`) avec sync périodique (`MangaSyncService`). Inclut un proxy de couvertures (302 redirect vers CDN MU) et le calcul de note communautaire Bayesian.
**Fichiers principaux :**
- `src/api/mangas/mangas.service.ts`
- `src/api/mangas/mangas.controller.ts`
- `src/api/mangas/manga.entity.ts`
- `src/api/mangas/sync-manga.service.ts`
- `src/api/mangas/cover-proxy.service.ts`
- `src/api/mangas/rating-aggregator.ts`

### 8. Recommandations
**Description :** Moteur de recommandations personnalisées basé sur la bibliothèque de l'utilisateur — scoring pondéré par statut de lecture (multiplier), récence (demi-vie 365 jours), et pool de candidats issus des `MangaRecommendation` MangaUpdates. Cap adaptatif (30/60 recos par source).
**Fichiers principaux :**
- `src/api/recommendations/recommendation.service.ts`
- `src/api/recommendations/recommendation.controller.ts`
- `src/api/mangas/manga-recommendation.entity.ts`

### 9. Amis (Friends)
**Description :** Système de demande d'amitié bidirectionnel (pending/accepted/blocked). Une seule ligne par couple (requester, addressee). Acceptation automatique si demande croisée. Recherche d'utilisateurs par username (ILIKE, exclusion des déjà-en-relation).
**Fichiers principaux :**
- `src/api/friends/friends.service.ts`
- `src/api/friends/friends.controller.ts`
- `src/api/friends/user-friendship.entity.ts`
- `src/api/friends/friends.module.ts`

### 10. Commentaires
**Description :** Commentaires sur les mangas avec threading à 1 niveau (réponses à un top-level), soft delete par l'auteur, filtre NSFW par regex à la création/édition, système de signalement (report) distinct.
**Fichiers principaux :**
- `src/api/comments/comments.service.ts`
- `src/api/comments/comments.controller.ts`
- `src/api/comments/manga-comment.entity.ts`
- `src/api/comments/comment-report.entity.ts`

### 11. Partage et groupes de lecture
**Description :** Partage de manga entre amis (contrainte : destinataire doit être un ami accepté, idempotence pour éviter le spam). Groupes de lecture partagés (max 10 membres) synchronisant la progression via poll client toutes les 30 s, sans websockets.
**Fichiers principaux :**
- `src/api/sharing/sharing.service.ts`
- `src/api/sharing/sharing.controller.ts`
- `src/api/sharing/reading-groups.service.ts`
- `src/api/sharing/reading-groups.controller.ts`
- `src/api/sharing/manga-share.entity.ts`
- `src/api/sharing/reading-group.entity.ts`

### 12. Health & Well-Known
**Description :** Endpoint `/health` vérifiant la connexion DB (`SELECT 1`) et exposant la version Git. Endpoints `/.well-known/assetlinks.json` (Android App Links) et `/.well-known/apple-app-site-association` (iOS Universal Links) configurés via env vars.
**Fichiers principaux :**
- `src/health/health.controller.ts`
- `src/api/well-known/well-known.controller.ts`

## Décisions techniques clés

1. **Sessions multi-appareils avec rotation** — chaque login crée une `UserSession` en base. Le refresh token est associé à un `sessionId` (encodé dans le JWT). La rotation crée d'abord la nouvelle session avant de supprimer l'ancienne pour éviter de laisser l'utilisateur déconnecté en cas d'erreur DB.

2. **`synchronize: false` obligatoire, migrations versionnées** — 14 migrations numérotées par timestamp dans `src/migrations/`, gérées via `typeorm-ts-node-commonjs`. `migrationsRun` automatique uniquement en production.

3. **Google OAuth dual-path** — deux flux : redirect web classique (`passport-google-oauth20`) pour les navigateurs, et vérification d'`idToken` (`google-auth-library`) pour le client Flutter mobile (`google_sign_in`). Liaison silencieuse : si un compte local existe déjà avec le même email, le `googleId` est simplement ajouté sans changer `authProvider`.

4. **Cache manga "stub-then-fill"** — un manga peut être inséré comme stub (`mu_id` + `title` seulement, covers nullable) lors de la découverte via les recos. Les détails sont chargés à la demande via `getMangaDetails`. Évite les appels MU pour des mangas jamais visités.

5. **Proxy covers en 302 redirect** — plutôt que de proxier les images côté serveur Node (problèmes User-Agent/IP), le controller redirige le client vers l'URL CDN MangaUpdates. Exploite le cache navigateur et le cache Cloudflare.

6. **Note communautaire Bayesian** — la note affichée est une agrégation Bayesian entre la moyenne locale des ratings utilisateurs et la note globale MangaUpdates, pondérée par le nombre de votes. Calcul in-service, pas de table dédiée.

7. **Throttler global + override local** — `ThrottlerGuard` global à 100 req/min/IP via `APP_GUARD`. Les endpoints d'auth (`/auth/login`, `/auth/register`, etc.) overrident avec `@Throttle()` à des seuils plus bas.

8. **RGPD consent versioning** — colonnes `acceptedTosVersion` + `acceptedPrivacyVersion` sur `User`. La constante `CURRENT_TOS_VERSION` dans `gdpr.service.ts` déclenche un flag `needsConsentRefresh` si la version stockée diffère.

9. **Avatar en colonne `text` (base64)** — décision temporaire pour éviter un pipeline multer, documentée comme TODO dans la migration `1746231600000`. Prévu : upload multipart + sharp + stockage fichier.

10. **Username unique case-insensitive via index Postgres** — unicité assurée par un index unique sur `LOWER(username)` (migration `1746231500000`), pas par une contrainte `UNIQUE` standard. Tous les lookups utilisent `ILike(...)`.

## Évaluation qualité globale

| Critère | État |
|---------|------|
| Tests présents | Partiel — specs unitaires sur `user.service`, `mangas.service`, `recommendation.service`, `rating-aggregator` ; un seul test e2e squelette dans `test/app.e2e-spec.ts` ; couverture faible sur les services sociaux (friends, comments, sharing) |
| Structure | Organisée par feature (`src/api/<module>/`) avec séparation Controller / Service / Entity / DTO. Sous-dossiers `auth/`, `gdpr/`, `stats/` dans `user/`. |
| Gestion d'erreurs | Centralisée via les exceptions NestJS (`HttpException`, `NotFoundException`, `ForbiddenException`, etc.) remontées depuis les services. Un `NotFoundInterceptor` global pour la bibliothèque. Pas de filtre d'exception global custom. |
| Documentation | Présente — `CLAUDE.md` complet, `memory-bank/` (architecture, progress, known-issues, decisions), `docs/` avec ADRs et specs, Swagger auto-généré sur `/api`. |
