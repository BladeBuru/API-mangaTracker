# Spec Fonctionnelle — Email transactionnel [DRAFT — à valider par le dev]

| Champ      | Valeur                    |
|------------|---------------------------|
| Module     | email                     |
| Version    | 0.1.0                     |
| Date       | 2026-06-04                |
| Auteur     | retro-documenter          |
| Statut     | DRAFT                     |
| Source     | Rétro-ingénierie          |

> **[DRAFT — à valider par le dev]** Cette spec a été générée par rétro-ingénierie
> à partir du code existant. Elle doit être relue et validée par un développeur
> qui connaît le contexte métier.

---

## ADRs

| ADR | Titre | Statut |
|-----|-------|--------|
| [RETRO-005](../../adr/RETRO-005-auto-login-post-email-action.md) | Auto-login JWT après vérification email et reset password | Documenté (rétro) |

> *Table auto-générée par adr-linker. Ne pas éditer manuellement.*

**ADR connexe (feature auth, impact direct sur ce module) :**

| ADR | Titre | Statut |
|-----|-------|--------|
| [RETRO-004](../../adr/RETRO-004-email-token-hashed-single-use.md) | Token email stocké hashé SHA-256, single-use anti-replay | Documenté (rétro) |

---

## Contexte et objectif

Le module `email` gère les deux flux d'authentification déclenchés par courrier électronique :

1. **Vérification d'adresse email** — envoyée à l'inscription, permet d'activer le compte.
2. **Réinitialisation de mot de passe** — déclenché à la demande de l'utilisateur, permet de récupérer l'accès à un compte.

Les emails sont envoyés via le relay SMTP Brevo (nodemailer), mis en forme avec des templates Handlebars bi-langue (fr/en), et s'appuient sur la table `auth_token` pour stocker les tokens à usage unique (voir RETRO-004).

---

## Règles métier (déduites du code)

### Vérification d'email

1. Un email de vérification n'est envoyé que si l'adresse n'est pas déjà vérifiée (`emailVerifiedAt IS NULL`). Si le compte est déjà vérifié, l'appel retourne silencieusement sans erreur.
2. L'envoi d'un nouvel email de vérification invalide automatiquement les tokens précédents du même type pour cet utilisateur (un seul lien actif à la fois).
3. Le lien de vérification expire après 60 minutes.
4. La validation du token marque immédiatement `emailVerifiedAt = now()` sur l'entité `User`.
5. Après validation réussie, un couple JWT (access + refresh) est émis directement — l'utilisateur est automatiquement connecté sans étape de login supplémentaire (voir RETRO-005).

### Reset password

6. La demande de reset retourne toujours HTTP 200, que l'email existe en base ou non (anti-énumération). Quand l'email n'existe pas, un délai aléatoire de 100–400 ms est simulé pour homogénéiser les temps de réponse (anti-timing attack).
7. Le lien de reset expire après 30 minutes (TTL plus court que la vérification d'email, car plus sensible).
8. La politique de complexité du nouveau mot de passe : minimum 8 caractères, au moins 1 chiffre OU 1 caractère spécial.
9. À la confirmation du reset, toutes les sessions actives de l'utilisateur sont révoquées (force re-login sur tous les appareils), puis un nouveau couple JWT est émis pour la session courante (auto-login, voir RETRO-005).

### Sécurité transversale

10. Les logs ne contiennent jamais l'adresse email du destinataire ni le contenu de l'email (RGPD + sécurité). Seuls `userId`, `template` et le résultat (`sent` / erreur) sont tracés.
11. Tous les cas d'échec de validation de token retournent le même message générique `'Invalid or expired token'` — aucune information discriminante n'est fournie à un éventuel attaquant.
12. Les tokens sont générés avec `crypto.randomBytes(32)` (CSPRNG, 256 bits d'entropie) et stockés hashés SHA-256 en base (voir RETRO-004).

---

## Cas d'usage (déduits)

### CU-001 — Vérification d'email à l'inscription

**Acteur** : utilisateur nouvellement inscrit

**Flux principal :**
1. L'utilisateur s'inscrit (via le module `auth`).
2. Un email de vérification est envoyé automatiquement (appelé depuis `auth.service` ou déclenché manuellement par l'endpoint `POST /auth/email/send-verification`).
3. L'utilisateur clique sur le lien reçu dans l'email.
4. Le client envoie `POST /auth/email/verify` avec le token extrait de l'URL.
5. Le serveur valide le token, marque le compte vérifié, et retourne `{ accessToken, refreshToken }`.
6. L'utilisateur est automatiquement connecté.

**Flux alternatif — email perdu :**
- L'utilisateur authentifié (JWT) appelle `POST /auth/email/send-verification` pour recevoir un nouvel email. L'ancien lien est automatiquement invalidé.

**Flux d'erreur :**
- Token invalide, expiré ou déjà utilisé → HTTP 400 `'Invalid or expired token'`.

### CU-002 — Réinitialisation de mot de passe

**Acteur** : utilisateur ayant perdu l'accès à son compte

**Flux principal :**
1. L'utilisateur soumet son email via `POST /auth/email/password/reset/request`.
2. Le serveur retourne HTTP 200 dans tous les cas.
3. Si l'email existe, un email de reset est envoyé avec un lien valable 30 minutes.
4. L'utilisateur clique sur le lien et soumet le nouveau mot de passe via `POST /auth/email/password/reset/confirm` (token + newPassword).
5. Le serveur valide le token, hash le nouveau mot de passe (bcrypt, saltRounds=10), révoque toutes les sessions actives, et retourne `{ accessToken, refreshToken }`.
6. L'utilisateur est automatiquement connecté avec le nouveau mot de passe.

**Flux d'erreur :**
- Token invalide, expiré ou déjà utilisé → HTTP 400.
- Mot de passe ne respectant pas la politique de complexité → HTTP 400 (rejeté par `ValidationPipe`).

---

## Dépendances

- `AuthTokenService` — génération, validation et consommation des tokens à usage unique (`auth_token`).
- `AuthService` — `issueTokensForUserId()` pour l'auto-login post-vérification/reset, `revokeAllSessionsForUser()` pour l'invalidation des sessions après reset.
- `UserRepository` (TypeORM) — lecture de l'entité `User` (email, username, emailVerifiedAt), mise à jour de `emailVerifiedAt` et `password`.
- `ConfigService` — lecture des variables d'environnement SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_FROM_NAME`, `PUBLIC_WEB_URL`).
- Relay SMTP Brevo — infrastructure d'envoi des emails.

---

## Zones d'incertitude

> Les points suivants n'ont pas pu être déterminés par le code seul :

- **Déclenchement de l'email d'inscription** : le code de `email.service.ts` expose `sendVerificationEmail()` mais il n'est pas visible dans ce module si l'envoi initial à l'inscription est déclenché automatiquement dans `auth.service` ou uniquement via l'endpoint `send-verification`. À confirmer.
- **Langue détectée** : la méthode `detectLang()` est actuellement hardcodée à `'fr'` avec un commentaire indiquant qu'elle "sera enrichie si on stocke une préférence `language` sur `User`". Il n'y a pas de colonne `language` visible dans l'entité `User`. La localisation future est donc incertaine.
- **Purge des tokens expirés** : la méthode `cleanupOldTokens()` existe dans `AuthTokenService` mais aucun scheduler NestJS (`@nestjs/schedule`) n'a été observé dans ce module. Il est possible qu'un `@Cron` soit câblé ailleurs dans le projet ou que cette purge ne soit pas encore activée (voir RETRO-004 Négatives/Dette).
- **Vérification obligatoire à l'inscription** : le code n'indique pas si les routes protégées par JWT vérifient que `emailVerifiedAt` est non-null. L'email est-il obligatoire pour accéder aux fonctionnalités de l'app ? À confirmer avec le dev.
