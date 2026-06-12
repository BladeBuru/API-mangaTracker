# RETRO-002 — Google OAuth dual-path (web redirect + idToken mobile)

| Champ      | Valeur              |
|------------|---------------------|
| Statut     | Documenté (rétro)   |
| Date       | 2026-06-04          |
| Source     | Rétro-ingénierie    |
| Features   | auth                |

## Justification (politique ADR v2.3.0)

| Champ | Valeur |
|-------|--------|
| Catégorie | AUTH |
| Q1 — Coût de revert > 1j ? | OUI — supprimer l'un des deux chemins impliquerait des modifications dans `auth.service`, `auth.controller`, `googleStrategy`, et côté client Flutter (le SDK `google_sign_in` ne peut pas faire de web redirect, et un navigateur web ne peut pas utiliser directement un idToken Flutter). Les deux surfaces client ont des contraintes mutuellement exclusives qui nécessitent les deux chemins. Refactoring > 1 journée. |
| Q2 — Non-déductible du code ? | OUI — `package.json` montre `passport-google-oauth20` ET `google-auth-library` comme dépendances, mais ne révèle pas qu'ils coexistent pour deux chemins distincts vers le même flux d'authentification, ni que le callback web envoie un deep link Flutter vs une page `postMessage` selon le User-Agent. |
| Q3 — Impact transverse (≥ 2 specs) ? | OUI — affecte la spec `auth` (deux endpoints `/auth/google` et `/auth/google/mobile`), la spec client mobile Flutter (intégration SDK `google_sign_in`), et tout futur client web (intégration OAuth redirect + réception du token via `postMessage`). |
| Q4 — Casse un invariant si ignoré ? | OUI — utiliser le chemin web redirect depuis une app mobile Flutter produirait des tokens non vérifiés (le flow OAuth redirect nécessite une session navigateur que Flutter ne peut pas exposer). Utiliser le chemin idToken depuis un navigateur web serait impossible (le SDK `google_sign_in` est spécifique à l'environnement mobile). |

> Validé contre la politique `.claude/rules/06-adr-policy.md`.

---

## Contexte

L'application Manga Tracker cible prioritairement Android (Flutter), avec iOS et Web prévus. Google propose deux mécanismes d'intégration OAuth incompatibles entre les clients mobiles natifs et les navigateurs web :

- **Mobile natif** : le SDK `google_sign_in` (Flutter) obtient directement un `idToken` depuis les APIs Google natives. Il ne peut pas effectuer un redirect OAuth classique (pas de navigateur contrôlé).
- **Web** : OAuth 2.0 Authorization Code Flow avec redirect vers `GOOGLE_CALLBACK_URL`. Le serveur reçoit les credentials via Passport.

Les deux chemins convergent vers la même fonction `findOrCreateGoogleUser` dans `AuthService`.

---

## Décision identifiée

Deux endpoints distincts, deux librairies, un seul service de finalisation :

**Chemin mobile (idToken)** :
- Endpoint : `POST /auth/google/mobile`
- Librairie : `google-auth-library` (`OAuth2Client.verifyIdToken`)
- Vérification : l'idToken est vérifié côté serveur contre l'audience `GOOGLE_CLIENT_ID`. Les claims `sub` (googleId) et `email` sont extraits du payload.

**Chemin web (redirect)** :
- Endpoints : `GET /auth/google` (initiation) + `GET /auth/google/callback` (callback)
- Librairie : `passport-google-oauth20` via `PassportStrategy`
- Résolution du client : détection User-Agent dans le callback — si Flutter/Dart → deep link `mangatracker://auth/callback?accessToken=...&refreshToken=...`, si navigateur web → page HTML avec `postMessage` (nonce CSP par requête).

**Convergence** : les deux chemins appellent `AuthService.findOrCreateGoogleUser(googleId, email, username, deviceInfo?)`.

---

## Conséquences observées

### Positives

- Un seul point de logique métier (`findOrCreateGoogleUser`) pour la création/liaison de compte Google, quelle que soit la surface client.
- Le chemin mobile est plus simple à maintenir (pas de gestion de session navigateur ni de redirect).
- Le chemin web est extensible pour un futur client web sans modifier le service.

### Négatives / Dette

- **Deux dépendances OAuth Google** (`passport-google-oauth20` + `google-auth-library`) à maintenir en parallèle.
- **Détection User-Agent fragile** : la logique `!ua.includes('Dart') && !ua.includes('Flutter')` dans le callback est un heuristique susceptible de false positives/negatives si Flutter change son User-Agent ou si un navigateur inclut ces chaînes.
- **`deviceInfo` absent du chemin web redirect** : `GoogleStrategy.validate` n'a pas accès au `deviceInfo` de l'appareil (non transmissible via le flow OAuth redirect standard). Toutes les sessions Google web auront `deviceInfo=null`.

---

## Recommandation

Garder — les deux chemins sont nécessaires et bien isolés.

Remplacer la détection User-Agent par un paramètre de query explicite sur le callback (ex: `?client=mobile|web`) transmis via le `state` OAuth pour fiabiliser la bifurcation.
