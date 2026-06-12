# Spec Fonctionnelle — Auth [DRAFT — à valider par le dev]

| Champ      | Valeur              |
|------------|---------------------|
| Module     | auth                |
| Version    | 0.1.0               |
| Date       | 2026-06-04          |
| Auteur     | retro-documenter    |
| Statut     | DRAFT               |
| Source     | Rétro-ingénierie    |

> **[DRAFT — à valider par le dev]** Cette spec a été générée par rétro-ingénierie
> à partir du code existant. Elle doit être relue et validée par un développeur
> qui connaît le contexte métier.

---

## ADRs

| ADR | Titre | Statut |
|-----|-------|--------|
| [RETRO-001](../../adr/RETRO-001-session-multidevice-rotation.md) | Sessions multi-appareils avec rotation create-before-delete | Documenté (rétro) |
| [RETRO-002](../../adr/RETRO-002-google-oauth-dual-path.md) | Google OAuth dual-path (web redirect + idToken mobile) | Documenté (rétro) |
| [RETRO-003](../../adr/RETRO-003-google-email-silent-account-linking.md) | Liaison silencieuse de compte Google par email | Documenté (rétro) |
| [RETRO-004](../../adr/RETRO-004-email-token-hashed-single-use.md) | Token email stocké hashé SHA-256, single-use anti-replay | Documenté (rétro) |

> *Table auto-générée par adr-linker. Ne pas éditer manuellement.*

---

## Contexte et objectif

Le module `auth` gère l'intégralité du cycle de vie d'une session utilisateur : inscription, connexion locale (email + mot de passe), connexion Google (deux chemins), rotation de tokens JWT, déconnexion ciblée ou globale, vérification de l'adresse email par magic link, et réinitialisation de mot de passe par email.

L'objectif est de fournir une authentification sécurisée multi-appareils pour l'application mobile Flutter (Android/iOS) et potentiellement un futur client web, sans état serveur centralisé (JWT stateless pour l'accès) tout en permettant la révocation explicite de sessions (persistées en base).

---

## Règles métier (déduites du code)

1. **Unicité email stricte** : deux comptes ne peuvent pas partager le même email. La vérification s'effectue en base avant toute création.
2. **Unicité username case-insensitive** : `John` et `john` sont considérés identiques. La contrainte est appliquée via un index unique sur `LOWER(username)` côté PostgreSQL et via un lookup `ILike` côté application.
3. **Séparation des providers** : un compte local (`authProvider=LOCAL`) et un compte Google (`authProvider=GOOGLE`) sont distincts. Un compte local peut acquérir un `googleId` sans perdre son `authProvider` ni son mot de passe — les deux méthodes de connexion coexistent.
4. **Liaison silencieuse Google par email** : si un compte local existe déjà avec l'adresse email retournée par Google, le `googleId` lui est associé sans recréer de compte ni modifier son `authProvider`.
5. **Session par appareil** : chaque connexion réussie crée une entrée `user_session` distincte. Une session est identifiée par un UUID et peut être associée à un `deviceInfo` libre (user-agent, nom de l'app, etc.).
6. **Rotation de session create-before-delete** : lors d'un refresh, la nouvelle session est créée AVANT la suppression de l'ancienne. En cas d'échec de création, l'ancienne reste valide.
7. **`lastLoginAt` mis à jour après session** : le timestamp de dernière connexion n'est mis à jour qu'après la création réussie de la session, pour ne pas marquer l'utilisateur comme connecté si aucun token ne lui est retourné.
8. **Déconnexion ciblée** : `POST /auth/logout` supprime uniquement la session courante (identifiée par le refresh token).
9. **Déconnexion globale** : `POST /auth/logout-all` supprime toutes les sessions actives de l'utilisateur.
10. **Auto-login post-vérification email** : après validation d'un token de vérification, un nouveau couple JWT est immédiatement émis sans redemander le mot de passe.
11. **Auto-login post-reset password** : après validation d'un token de reset, toutes les sessions existantes sont révoquées, un nouveau couple JWT est émis.
12. **Anti-énumération sur le reset password** : la réponse à `POST /auth/email/password/reset/request` est toujours `200 { ok: true }`, que l'email existe ou non. Un délai aléatoire (100–400 ms) est simulé quand l'email n'existe pas pour homogénéiser les temps de réponse.
13. **Token email à usage unique** : les tokens de vérification et de reset sont générés aléatoirement (32 bytes via CSPRNG), stockés hashés (SHA-256) en base, et marqués `usedAt` à la consommation. Toute tentative de réutilisation échoue.
14. **Invalidation des tokens précédents** : la création d'un nouveau token du même type pour le même utilisateur invalide (marque `usedAt=now()`) tous les tokens non encore consommés du même type.
15. **TTL token** : 60 minutes pour la vérification d'email, 30 minutes pour le reset password.
16. **Envoi de l'email de vérification fire-and-forget** : l'email est envoyé après l'inscription sans bloquer la réponse HTTP. Une panne SMTP ne fait pas échouer l'inscription.
17. **Callback Google web avec nonce CSP** : la réponse HTML du callback Google pour les navigateurs web utilise un nonce par requête pour autoriser le script inline `postMessage`, sans `'unsafe-inline'` global.

---

## Cas d'usage (déduits)

### CU-001 — Inscription locale

**Acteur** : utilisateur non authentifié  
**Précondition** : email et username non encore utilisés  
**Flux** :
1. `POST /auth/register` avec `{ email, password, name }`.
2. Vérification unicité email (exact) et username (case-insensitive).
3. Création de l'entité `User` avec `authProvider=LOCAL`, mot de passe hashé bcrypt (salt 10).
4. Retour de l'entité user (sans password) — `UserInformationDto`.
5. Envoi fire-and-forget de l'email de vérification.

**Postcondition** : compte créé, email de vérification en route, session non encore créée (l'utilisateur doit ensuite appeler `/auth/login`).

### CU-002 — Connexion locale

**Acteur** : utilisateur enregistré via email/password  
**Flux** :
1. `POST /auth/login` avec `{ email, password, deviceInfo? }`.
2. Vérification existence du compte et que `authProvider=LOCAL`.
3. Vérification mot de passe via bcrypt.
4. Création de la session, mise à jour de `lastLoginAt`.
5. Retour `{ accessToken, refreshToken }`.

### CU-003 — Connexion Google (mobile Flutter)

**Acteur** : utilisateur sur application mobile  
**Flux** :
1. Flutter obtient un `idToken` via `google_sign_in`.
2. `POST /auth/google/mobile` avec `{ idToken, deviceInfo? }`.
3. Vérification de l'`idToken` par Google (via `OAuth2Client.verifyIdToken`).
4. `findOrCreateGoogleUser` : liaison silencieuse ou création de compte.
5. Création de session, retour des tokens.

### CU-004 — Connexion Google (web redirect)

**Acteur** : utilisateur sur navigateur web  
**Flux** :
1. `GET /auth/google` → redirection vers Google OAuth.
2. Google rappelle `GET /auth/google/callback`.
3. Passport `GoogleStrategy` appelle `findOrCreateGoogleUser`.
4. Détection du User-Agent : si Flutter/Dart → deep link `mangatracker://auth/callback?...`, sinon → page HTML avec `postMessage` (nonce CSP).

### CU-005 — Refresh de session

**Acteur** : client avec un refresh token valide  
**Flux** :
1. `POST /auth/refresh` avec refresh token en `Authorization: Bearer`.
2. `RefreshTokenGuard` valide le token via la stratégie `jwt-refresh`.
3. `AuthService.refresh` : vérification de l'existence de la session en base, création de la nouvelle session, suppression de l'ancienne.
4. Retour de nouveaux `{ accessToken, refreshToken }`.

### CU-006 — Vérification d'email

**Acteur** : utilisateur ayant reçu un email de vérification  
**Flux** :
1. Clic sur le lien → appel `POST /auth/email/verify` avec `{ token }`.
2. `AuthTokenService.verifyAndConsume` valide et consomme le token.
3. `emailVerifiedAt` mis à jour sur l'entité `User`.
4. Auto-login : retour immédiat de `{ accessToken, refreshToken }`.

### CU-007 — Reset password

**Acteur** : utilisateur ayant oublié son mot de passe  
**Flux** :
1. `POST /auth/email/password/reset/request` avec `{ email }` → 200 toujours.
2. Si le compte existe : token généré, email envoyé.
3. `POST /auth/email/password/reset/confirm` avec `{ token, newPassword }`.
4. Token vérifié et consommé, mot de passe hashé mis à jour.
5. Toutes les sessions révoquées, auto-login.

### CU-008 — Déconnexion ciblée / globale

**Flux logout ciblé** : `POST /auth/logout` avec refresh token → suppression de la session courante uniquement.  
**Flux logout global** : `POST /auth/logout-all` avec access token → suppression de toutes les sessions de l'utilisateur.

---

## Dépendances

- `User` entity (`src/api/user/user.entity.ts`) — entité centrale portant `authProvider`, `googleId`, `emailVerifiedAt`, champs RGPD, `lastLoginAt`.
- `UserSession` entity — sessions persistées en base avec cascade `onDelete: 'CASCADE'` sur l'utilisateur.
- `AuthToken` entity — tokens email hashés.
- `JwtModule` (`@nestjs/jwt`) — signature et vérification des tokens.
- `EmailModule` / `EmailService` — envoi des emails transactionnels via Brevo (SMTP).
- `AuthTokenService` — génération, vérification, consommation des tokens email.
- `GDPR module` (indirect) — `AuthService.revokeAllSessionsForUser` est appelé depuis d'autres modules pour les flows de purge RGPD.
- `FriendsService` (indirect) — lookups username case-insensitive partagent la même convention `ILike`.

---

## Zones d'incertitude

> Les points suivants n'ont pas pu être déterminés par le code seul :

- **Vérification email obligatoire ou optionnelle** : le code définit `emailVerifiedAt` et l'envoie en fire-and-forget, mais il n'est pas visible dans ce module si certaines actions sont bloquées pour les comptes non vérifiés (la logique de gate est peut-être dans d'autres modules).
- **Consentement RGPD au register** : le code `register` ne persiste pas les champs `acceptedTosAt`/`acceptedTosVersion` — ces champs existent sur l'entité mais semblent alimentés par un flow GDPR séparé. Valider si le consentement est requis avant ou après l'inscription.
- **Portée du `deviceInfo`** : le champ est libre (user-agent, nom d'app). Il n'y a pas de validation ni de déduplication visible. Valider si la liste des sessions est affichée à l'utilisateur (gestion multi-appareils visible dans l'UI).
- **Langue de détection pour les emails** : `detectLang` retourne toujours `'fr'`. La logique de détection multi-langue n'est pas implémentée. Valider si le support multi-langue email est prévu.
- **Purge des `auth_token` expirés** : `cleanupOldTokens()` existe dans `AuthTokenService` mais aucun `Cron` n'est visible dans ce module. Valider où et à quelle fréquence ce job est déclenché.
- **Limite de sessions par utilisateur** : il n'y a pas de cap visible sur le nombre de sessions actives simultanées. Valider si un utilisateur peut en théorie accumuler un nombre illimité de sessions.
