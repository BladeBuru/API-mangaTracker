# Spec Technique — Email transactionnel

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | email               |
| Version       | 0.1.0               |
| Date          | 2026-06-04          |
| Source        | Rétro-ingénierie    |

---

## Architecture du module

Le module `email` se compose de quatre composants principaux :

- **`EmailController`** — expose les endpoints HTTP du flow email (`send-verification`, `verify`, `password/reset/request`, `password/reset/confirm`). Délègue toute la logique à `EmailService` et `AuthService`.
- **`EmailService`** — orchestre l'envoi des emails transactionnels (SMTP via nodemailer), compile les templates Handlebars au boot et les garde en mémoire, construit les liens à partir de `PUBLIC_WEB_URL`, marque `emailVerifiedAt` et met à jour le `password` via `UserRepository`.
- **`AuthTokenService`** — génère, stocke (hashés), valide et consomme les tokens à usage unique. Gère le cycle de vie complet des tokens `auth_token`.
- **`AuthToken` (entity)** — représentation ORM de la table `auth_token` avec les colonnes `tokenHash`, `type`, `expiresAt`, `usedAt`, `createdIp`.

Les deux services (`EmailService` et `AuthTokenService`) sont injectables et peuvent être appelés depuis d'autres modules (notamment `auth.service` pour le déclenchement du mail d'inscription).

---

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/user/auth/email/email.service.ts` | Envoi SMTP, compilation templates, vérification token, reset password | ~300 |
| `src/api/user/auth/email/email.controller.ts` | Endpoints HTTP du flow email, throttling, auto-login | ~145 |
| `src/api/user/auth/email/auth-token.service.ts` | CRUD tokens à usage unique, hashing SHA-256, cleanup | ~160 |
| `src/api/user/auth/email/auth-token.entity.ts` | Entité ORM `auth_token` | ~78 |
| `src/api/user/auth/email/templates/verify-email.hbs` | Template HTML email de vérification (fr/en) | ~80 |
| `src/api/user/auth/email/templates/reset-password.hbs` | Template HTML email de reset password (fr/en) | ~87 |
| `src/api/user/auth/email/dto/verify-email.dto.ts` | DTO validation token hex 64 chars | ~15 |
| `src/api/user/auth/email/dto/request-password-reset.dto.ts` | DTO validation email (format, lowercase transform) | ~18 |
| `src/api/user/auth/email/dto/confirm-password-reset.dto.ts` | DTO token + nouveau mot de passe (politique complexité) | ~41 |

---

## Schéma BDD

### Table `auth_token`

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | uuid | PK | Identifiant interne |
| `user_id` | integer | FK → `user(id)` ON DELETE CASCADE | Propriétaire du token |
| `token_hash` | varchar(64) | INDEX UNIQUE | SHA-256 hex du token brut |
| `type` | varchar(32) | | `email_verify` ou `password_reset` |
| `expires_at` | timestamp | NOT NULL | Expiration absolue |
| `used_at` | timestamp | NULLABLE, default NULL | Timestamp de consommation (null = pas encore utilisé) |
| `created_ip` | varchar(45) | NULLABLE | IP du client à la création (audit) |
| `created_at` | timestamp | auto | Timestamp de création |

**Index** :
- `INDEX UNIQUE (token_hash)` — lookup O(1) lors de la validation.
- `INDEX (user_id, type)` — invalidation en masse lors de la création d'un nouveau token.

**Relation** : `ManyToOne` vers `User` avec `onDelete: 'CASCADE'` — suppression de l'utilisateur = suppression de tous ses tokens.

---

## API / Endpoints

| Méthode | Route | Auth | Throttle | Description |
|---------|-------|------|----------|-------------|
| `POST` | `/auth/email/send-verification` | JWT requis | 3 req/min | Renvoie l'email de vérification (utilisateur connecté non encore vérifié) |
| `POST` | `/auth/email/verify` | Public | 10 req/min | Valide le token de vérification, retourne `{ accessToken, refreshToken }` |
| `POST` | `/auth/email/password/reset/request` | Public | 3 req/min | Demande un reset password, retourne toujours `{ ok: true }` |
| `POST` | `/auth/email/password/reset/confirm` | Public | 5 req/min | Confirme le reset avec token + nouveau mot de passe, retourne `{ accessToken, refreshToken }` |

**Format de réponse succès :**
- `send-verification` : `{ ok: true }`
- `verify` : `{ accessToken: string, refreshToken: string }`
- `password/reset/request` : `{ ok: true }`
- `password/reset/confirm` : `{ accessToken: string, refreshToken: string }`

**Codes d'erreur :**
- `400` — token invalide/expiré/déjà consommé, ou mot de passe ne respectant pas la politique de complexité.
- `503` — indisponibilité SMTP (credentials manquants ou erreur d'envoi).
- `401` — JWT manquant ou invalide sur `send-verification`.

---

## Patterns identifiés

### Transporter SMTP lazy-init avec singleton interne

`EmailService` crée l'objet `Transporter` nodemailer la première fois qu'un email est envoyé (lazy), puis le réutilise via `this.transporter` (singleton dans le scope du service). Les credentials SMTP sont vérifiés à ce moment-là ; si `SMTP_USER` ou `SMTP_PASSWORD` sont absents, une `ServiceUnavailableException` est levée immédiatement.

### Compilation Handlebars au boot

Les templates `.hbs` sont lus depuis le système de fichiers et compilés (`Handlebars.compile()`) dans le constructeur du service, stockés dans une `Map<EmailTemplate, HandlebarsTemplateDelegate>`. Si un fichier est absent, un `warn` est loggué mais le service ne plante pas (fail soft). Le rendu est fait à chaque envoi en passant un objet `context`.

### Bi-langue via flag `isFr`

Les templates reçoivent `{ lang: 'fr'|'en', isFr: boolean, ... }`. Le flag `isFr` est utilisé dans les partials `{{#if isFr}}...{{else}}...{{/if}}` plutôt que des fichiers séparés par langue. La détection de langue (`detectLang()`) est actuellement hardcodée à `'fr'`.

### Politique de complexité mot de passe (NIST-inspired)

`ConfirmPasswordResetDto` applique : min 8 chars, max 128 chars, au moins 1 chiffre OU 1 caractère spécial (regex). Pas de contrainte de caractères majuscules/minuscules obligatoires, conformément à la recommandation NIST SP 800-63B qui privilégie la longueur sur la complexité arbitraire.

### Anti-énumération sur reset password

`EmailService.sendPasswordResetEmail()` retourne `void` dans tous les cas. Si l'email n'existe pas en base, un délai aléatoire 100–400 ms est simulé avant le retour pour homogénéiser les temps de réponse avec le cas où l'email existe (envoi SMTP réel). Le controller retourne `{ ok: true }` dans tous les cas.

### Auto-login post-action email (voir RETRO-005)

`/auth/email/verify` et `/auth/email/password/reset/confirm` appellent `authService.issueTokensForUserId(userId, ip)` après validation réussie du token, et retournent directement `{ accessToken, refreshToken }`. Le client n'a pas besoin de faire un `/auth/login` séparé.

### Invalidation totale des sessions après reset

Dans `EmailController.confirmPasswordReset()`, après la confirmation du nouveau mot de passe, `authService.revokeAllSessionsForUser(userId)` est appelé avant d'émettre de nouveaux JWT. Garantit qu'un refresh token volé ne peut plus être utilisé après un reset.

### Cleanup tokens — méthode non câblée

`AuthTokenService.cleanupOldTokens()` purge les tokens avec `expiresAt < (now - 7j)` mais aucun `@Cron` n'est visible dans le module. Cette méthode doit être connectée à un scheduler (`@nestjs/schedule`) pour éviter l'accumulation de lignes en base.

---

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|---------------|--------|
| — | EmailService | Absent (à créer) |
| — | AuthTokenService (createToken, verifyAndConsume, cleanup) | Absent (à créer) |
| — | EmailController (endpoints verify/reset) | Absent (à créer) |

Aucun fichier de test n'a été détecté pour ce module lors de la rétro-ingénierie.

---

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `SMTP_HOST` | `smtp-relay.brevo.com` | Hôte du relay SMTP |
| `SMTP_PORT` | `587` | Port SMTP (587=STARTTLS, 465=TLS direct) |
| `SMTP_USER` | — (obligatoire) | Login Brevo |
| `SMTP_PASSWORD` | — (obligatoire) | Clé SMTP master Brevo |
| `SMTP_FROM` | `noreply@bladeburu.com` | Adresse expéditeur |
| `SMTP_FROM_NAME` | `Manga Tracker` | Nom affiché dans l'email |
| `PUBLIC_WEB_URL` | `https://bladeburu.com` | Base pour les liens dans les emails |

**Note** : `SMTP_USER` et `SMTP_PASSWORD` ne doivent jamais être versionnés (voir règle `env-secret-guard.md`).
