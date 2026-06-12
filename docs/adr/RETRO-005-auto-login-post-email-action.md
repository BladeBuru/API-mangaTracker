# RETRO-005 — Auto-login JWT après vérification email et reset password

| Champ      | Valeur              |
|------------|---------------------|
| Statut     | Documenté (rétro)   |
| Date       | 2026-06-04          |
| Source     | Rétro-ingénierie    |
| Features   | email               |

## Justification (politique ADR v2.3.0)

| Champ | Valeur |
|-------|--------|
| Catégorie | AUTH |
| Q1 — Coût de revert > 1j ? | OUI — changer ce comportement modifie le contrat de réponse des endpoints `/auth/email/verify` et `/auth/email/password/reset/confirm` (passage de `{ accessToken, refreshToken }` à `{ ok: true }`), casse les clients Flutter qui utilisent ces tokens pour naviguer directement après l'action, et nécessite un ajout d'étape de login côté client dans les deux flows ; un bump de version d'API et une mise à jour des clients mobiles sont requis. |
| Q2 — Non-déductible du code ? | OUI — `package.json` et les configs ne révèlent pas que la validation d'un email ou la confirmation d'un reset retourne immédiatement des JWT plutôt qu'un simple `{ ok: true }` suivi d'un login séparé ; cette décision de design est encodée dans `email.controller.ts` (appels à `authService.issueTokensForUserId`) et n'est déductible d'aucune dépendance. |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — affecte la spec `email` (endpoints verify et reset/confirm), la spec `auth` (contrat de `issueTokensForUserId` utilisé dans deux flows distincts), et tout client (Flutter) qui implémente le parcours d'inscription ou de récupération de compte. |
| Q4 — Casse un invariant si ignoré ? | OUI — un dev qui implémenterait `/verify` en retournant `{ ok: true }` sans émettre de JWT briserait le flow d'inscription (l'app Flutter attend des tokens pour authentifier la session immédiatement après la vérification) ; l'utilisateur se retrouverait avec un compte vérifié mais sans être connecté, cassant silencieusement l'expérience d'onboarding. |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

---

## Contexte

Dans un flow d'inscription classique, l'utilisateur s'inscrit, vérifie son email en cliquant sur un lien, puis revient sur l'écran de connexion pour entrer ses identifiants. Ce double aller-retour est une friction inutile dans un contexte mobile : l'utilisateur vient de prouver qu'il contrôle l'adresse email, ce qui constitue une forme d'authentification suffisante pour émettre des JWT directement.

De même, après un reset de mot de passe, l'utilisateur a prouvé qu'il contrôle l'adresse email (token reçu) ET a défini un nouveau mot de passe. Lui demander de se reconnecter immédiatement serait redondant.

---

## Décision identifiée

Les endpoints `POST /auth/email/verify` et `POST /auth/email/password/reset/confirm` appellent `authService.issueTokensForUserId(userId, ip)` après la validation réussie du token email et retournent directement `{ accessToken: string, refreshToken: string }` au lieu d'un simple `{ ok: true }`.

Le client peut donc utiliser ces tokens immédiatement pour authentifier ses requêtes suivantes, sans faire de requête `/auth/login` supplémentaire.

---

## Conséquences observées

### Positives

- Expérience d'onboarding fluide sur mobile : l'utilisateur est connecté dès la vérification de son email, sans friction supplémentaire.
- Après un reset password, l'utilisateur retrouve immédiatement accès à l'app sur l'appareil depuis lequel il a fait la demande.
- La révocation de toutes les autres sessions (via `revokeAllSessionsForUser` dans le flow reset) est cohérente avec l'auto-login : on révoque tout, puis on crée une session propre pour l'appareil courant.

### Négatives / Dette

- **Contrat de réponse atypique** : les endpoints de vérification/reset retournent des tokens JWT, ce qui peut surprendre un développeur habitué à des flows en deux étapes. Le commentaire dans `email.controller.ts` documente ce choix mais il reste implicite.
- **Tests à adapter** : tout test qui s'attend à un `{ ok: true }` sur ces endpoints est incorrect. Les tests d'intégration doivent valider la présence de `accessToken` et `refreshToken` dans la réponse.
- **Dépendance forte sur `AuthService`** : `EmailController` injecte `AuthService` via `@Inject(AuthService)` pour accéder à `issueTokensForUserId`. Cette dépendance circulaire potentielle (auth module → email module → auth module) doit être gérée avec attention si les modules NestJS sont restructurés.

---

## Recommandation

Garder — la décision est cohérente avec une app mobile-first où la réduction des frictions est prioritaire, et elle est documentée dans les commentaires du controller.

S'assurer que cette sémantique est explicitement documentée dans les tests d'intégration (les tests de `/verify` et `/password/reset/confirm` doivent asserter la présence de `accessToken` + `refreshToken`).
