# Spec Technique — Auth

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | auth                |
| Version       | 0.1.0               |
| Date          | 2026-06-04          |
| Source        | Rétro-ingénierie    |

---

## Architecture du module

Le module `auth` est structuré en deux sous-modules NestJS distincts : `AuthModule` et `EmailModule` (référencés en `forwardRef` pour éviter les dépendances circulaires).

```
auth/
├── auth.module.ts          — Module principal, exporte AuthService + AuthHelper
├── auth.controller.ts      — Endpoints publics (register, login, logout, Google OAuth)
├── auth.service.ts         — Logique métier d'authentification
├── auth.helper.ts          — Utilitaires : bcrypt, JWT, CRUD sessions
├── auth.dto.ts             — RegisterDto, LoginDto, TokenDto, GoogleMobileLoginDto
├── user-session.entity.ts  — Entité session persistée en base
├── guard/
│   ├── auth.guard.ts           — JwtAuthGuard (alias @nestjs/passport AuthGuard('jwt'))
│   └── refreshToken.guard.ts   — RefreshTokenGuard (AuthGuard('jwt-refresh'))
├── strategy/
│   ├── accessTokenStrategy.ts  — Passport 'jwt' (Bearer token, secret JWT_KEY)
│   ├── refreshTokenStrategy.ts — Passport 'jwt-refresh' (secret JWT_REFRESH_SECRET)
│   └── googleStrategy.ts       — Passport 'google' (OAuth2, passport-google-oauth20)
└── email/
    ├── email.module.ts
    ├── email.controller.ts     — /auth/email/* (verify, password reset)
    ├── email.service.ts        — Envoi via Brevo SMTP, Handlebars templates
    ├── auth-token.service.ts   — Génération/validation tokens email (SHA-256)
    ├── auth-token.entity.ts    — Table auth_token (hash, type, TTL, usedAt)
    └── dto/
        ├── verify-email.dto.ts
        ├── request-password-reset.dto.ts
        └── confirm-password-reset.dto.ts
```

### Flux d'appel (connexion locale)

```
AuthController.login()
  └── AuthService.login()
        ├── repository.findOne({email})
        ├── AuthHelper.isPasswordValid()   — bcrypt.compareSync
        ├── AuthHelper.createSession()     — INSERT user_session
        ├── repository.update(lastLoginAt)
        └── AuthHelper.generateToken()     — jwt.signAsync x2
```

### Flux d'appel (refresh)

```
POST /auth/refresh
  ├── RefreshTokenGuard.canActivate()
  │     └── RefreshTokenStrategy.validate()  — vérifie JWT_REFRESH_SECRET, extrait {user, sessionId}
  └── AuthService.refresh()
        ├── AuthHelper.findSession(sessionId)
        ├── AuthHelper.createSession()     — nouvelle session
        ├── AuthHelper.deleteSession()     — ancienne session (non bloquant si échec)
        ├── repository.update(lastLoginAt)
        └── AuthHelper.generateToken()
```

---

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/user/auth/auth.service.ts` | Logique métier : register, login, logout, refresh, Google, issueTokens, revokeSessions | ~257 |
| `src/api/user/auth/auth.controller.ts` | Routes HTTP : register, login, logout, logout-all, google, google/callback, google/mobile | ~185 |
| `src/api/user/auth/auth.helper.ts` | Utilitaires bcrypt + JWT + CRUD sessions | ~90 |
| `src/api/user/auth/user-session.entity.ts` | Entité TypeORM `user_session` | ~29 |
| `src/api/user/auth/auth.dto.ts` | DTOs d'entrée/sortie | ~57 |
| `src/api/user/auth/strategy/accessTokenStrategy.ts` | Passport strategy 'jwt' | ~24 |
| `src/api/user/auth/strategy/refreshTokenStrategy.ts` | Passport strategy 'jwt-refresh' | ~29 |
| `src/api/user/auth/strategy/googleStrategy.ts` | Passport strategy 'google' | ~46 |
| `src/api/user/auth/guard/refreshToken.guard.ts` | Guard spécialisé pour le refresh | ~18 |
| `src/api/user/auth/email/email.controller.ts` | Routes /auth/email/* | ~144 |
| `src/api/user/auth/email/email.service.ts` | SMTP Brevo + Handlebars | ~300 |
| `src/api/user/auth/email/auth-token.service.ts` | Génération/validation/consommation token | ~160 |
| `src/api/user/auth/email/auth-token.entity.ts` | Entité TypeORM `auth_token` | ~77 |
| `src/api/user/user.entity.ts` | Entité User (authProvider, googleId, emailVerifiedAt, RGPD, sessions) | ~172 |

---

## Schéma BDD

### Table `user` (extrait colonnes auth)

| Colonne | Type | Contrainte | Rôle |
|---------|------|-----------|------|
| `id` | SERIAL | PK | Identifiant numérique |
| `email` | varchar | NOT NULL | Adresse email (lookup exact) |
| `password` | varchar | NULLABLE | Hash bcrypt (null pour comptes Google) |
| `google_id` | varchar | NULLABLE | Sub Google (peut coexister avec password) |
| `auth_provider` | varchar | DEFAULT 'local' | `local` ou `google` |
| `email_verified_at` | timestamp | NULLABLE | Null = non vérifié |
| `last_login_at` | timestamp | NULLABLE | Mis à jour après session créée |

Index non-standard : `UNIQUE INDEX ON LOWER(username)` (migration `1746231500000-AddUsernameUniqueIndex`).

### Table `user_session`

| Colonne | Type | Contrainte | Rôle |
|---------|------|-----------|------|
| `id` | uuid | PK | Identifiant de session (randomUUID) |
| `user_id` | int | FK → user(id) CASCADE | Propriétaire |
| `device_info` | varchar | NULLABLE | Identifiant libre de l'appareil |
| `created_at` | timestamp | DEFAULT NOW | Date de création |

Cascade : `onDelete: 'CASCADE'` — suppression du user supprime toutes ses sessions.

### Table `auth_token`

| Colonne | Type | Contrainte | Rôle |
|---------|------|-----------|------|
| `id` | uuid | PK | Identifiant |
| `user_id` | int | FK → user(id) CASCADE | Propriétaire |
| `token_hash` | varchar(64) | UNIQUE INDEX | SHA-256 hex du token brut |
| `type` | varchar(32) | NOT NULL | `email_verify` ou `password_reset` |
| `expires_at` | timestamp | NOT NULL | TTL absolu |
| `used_at` | timestamp | NULLABLE | NULL = non consommé ; set = consommé |
| `created_ip` | varchar(45) | NULLABLE | IP du client, audit |
| `created_at` | timestamp | DEFAULT NOW | Date de création |

Index composites : `(token_hash)` unique, `(user_id, type)` pour la révocation en cascade.

---

## API / Endpoints

### AuthController (`/auth`)

| Méthode | Route | Description | Auth |
|---------|-------|-------------|------|
| POST | `/auth/register` | Inscription locale | Aucune |
| POST | `/auth/login` | Connexion locale | Aucune |
| POST | `/auth/refresh` | Rotation de session | RefreshTokenGuard |
| POST | `/auth/logout` | Déconnexion appareil courant | RefreshTokenGuard |
| POST | `/auth/logout-all` | Déconnexion tous les appareils | JwtAuthGuard |
| POST | `/auth/google/mobile` | Connexion Google (idToken Flutter) | Aucune |
| GET | `/auth/google` | Redirect OAuth Google (web) | Aucune (initie OAuth) |
| GET | `/auth/google/callback` | Callback OAuth Google | AuthGuard('google') |

### EmailController (`/auth/email`)

| Méthode | Route | Description | Auth | Throttle |
|---------|-------|-------------|------|---------|
| POST | `/auth/email/send-verification` | Renvoi mail vérif | JwtAuthGuard | 3/min |
| POST | `/auth/email/verify` | Valide token + auto-login | Aucune | 10/min |
| POST | `/auth/email/password/reset/request` | Demande reset (anti-enum) | Aucune | 3/min |
| POST | `/auth/email/password/reset/confirm` | Confirme reset + auto-login | Aucune | 5/min |

---

## Payload JWT

**Access token** (`JWT_KEY`) :
```json
{ "id": <userId:number> }
```
Durée : `JWT_KEY_EXPIRES_IN` (variable d'environnement).

**Refresh token** (`JWT_REFRESH_SECRET`) :
```json
{ "id": <userId:number>, "sessionId": "<uuid>" }
```
Durée : `JWT_REFRESH_SECRET_EXPIRES_IN` (variable d'environnement).
Le `sessionId` sert de référence à la session en base pour la rotation et la révocation.

---

## Patterns identifiés

- **Service/Controller strict** : `AuthController` ne contient aucune logique métier. Il délègue intégralement à `AuthService` et `EmailService`.
- **Helper pattern** : `AuthHelper` regroupe les utilitaires bas niveau (bcrypt, JWT, CRUD sessions) injectés à la fois dans `AuthService` et via les stratégies Passport.
- **Passport Strategy pattern** : trois stratégies distinctes (`JwtStrategy`, `RefreshTokenStrategy`, `GoogleStrategy`) configurées à l'initialisation du module via `super(config)`.
- **Guard spécialisé** : `RefreshTokenGuard` étend `AuthGuard('jwt-refresh')` pour surcharger `handleRequest` et transmettre le payload `{user, sessionId}` sans lever d'exception par défaut.
- **Create-before-delete pour la rotation** : invariant de robustesse documenté en commentaire dans `auth.service.ts` (lignes 97–108 et 118–136).
- **Fire-and-forget sur l'email** : `.catch(warn)` pour ne pas bloquer la réponse HTTP sur un échec SMTP.
- **Anti-énumération** : réponse 200 systématique + `simulateDelay` (100–400ms random) sur `/password/reset/request`.
- **Nonce CSP par requête** : `randomBytes(16).toString('base64')` pour le script `postMessage` du callback Google web, override de l'en-tête `Content-Security-Policy` pour cette réponse uniquement.

---

## Sécurité (décisions locales — hors ADR)

- **bcrypt saltRounds=10** : constante dans `auth.helper.ts:encodePassword` et `email.controller.ts:confirmPasswordReset`.
- **Token email 32 bytes CSPRNG** : `randomBytes(TOKEN_BYTES)` où `TOKEN_BYTES=32` (256 bits d'entropie).
- **Logging RGPD** : aucun email destinataire ni contenu d'email n'est logué. Seuls `userId`, `template` et `success/error` sont tracés.
- **Anti-énumération** : réponse 200 uniforme sur le reset password + délai aléatoire 100–400ms pour homogénéiser les temps de réponse.
- **Throttle agressif sur les endpoints email** : 3/min sur les envois, 10/min sur la vérification, 5/min sur la confirmation de reset.
- **Invalidation en cascade** : la création d'un nouveau token du même type invalide les tokens précédents non consommés (garantit un seul lien actif à la fois).
- **Consommation atomique** : `UPDATE auth_token SET used_at=now() WHERE id=:id AND used_at IS NULL` — si la requête arrive en doublon, le second `affected=0` déclenche une exception.

---

## Configuration (variables d'environnement requises)

| Variable | Usage |
|----------|-------|
| `JWT_KEY` | Secret de signature des access tokens |
| `JWT_KEY_EXPIRES_IN` | Durée d'expiration des access tokens (ex: `15m`) |
| `JWT_REFRESH_SECRET` | Secret de signature des refresh tokens |
| `JWT_REFRESH_SECRET_EXPIRES_IN` | Durée d'expiration des refresh tokens (ex: `7d`) |
| `GOOGLE_CLIENT_ID` | ID client OAuth Google |
| `GOOGLE_CLIENT_SECRET` | Secret OAuth Google |
| `GOOGLE_CALLBACK_URL` | URL de callback OAuth (ex: `https://api.domain.com/auth/google/callback`) |
| `SMTP_HOST` | Relay SMTP (défaut: `smtp-relay.brevo.com`) |
| `SMTP_PORT` | Port SMTP (défaut: `587`) |
| `SMTP_USER` | Login SMTP Brevo |
| `SMTP_PASSWORD` | Clé SMTP master |
| `SMTP_FROM` | Adresse expéditeur (ex: `noreply@bladeburu.com`) |
| `SMTP_FROM_NAME` | Nom affiché (ex: `Manga Tracker`) |
| `PUBLIC_WEB_URL` | Base URL pour les liens dans les emails (ex: `https://bladeburu.com`) |

---

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|---------------|--------|
| N/A | Tests unitaires/e2e auth | Absent (non trouvé dans le module) |

> Aucun fichier `*.spec.ts` n'a été identifié dans `src/api/user/auth/`. La couverture de test est à créer.
