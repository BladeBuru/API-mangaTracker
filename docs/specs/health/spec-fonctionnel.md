# Spec Fonctionnelle — Health & Well-Known [DRAFT — à valider par le dev]

| Champ      | Valeur              |
|------------|---------------------|
| Module     | health              |
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

Aucun ADR RETRO créé pour cette feature (tous les candidats ont été rejetés — voir rapport ADR en fin de session).

---

## Contexte et objectif

La feature **health** regroupe deux préoccupations d'infrastructure exposées via l'API NestJS :

1. **Healthcheck applicatif** (`/health`) : permet à la CI/CD, aux load balancers et aux outils de monitoring de vérifier en temps réel que l'API est opérationnelle et que la base de données est joignable.

2. **Verification d'identité de domaine** (`/.well-known/*`) : expose les fichiers de déclaration requis par les plateformes mobiles pour activer les fonctionnalités de deep-linking (Android App Links, Apple Universal Links). Ces fichiers sont servis directement par l'API sur `api.bladeburu.com`, en tirant parti du cache Cloudflare, sans nécessiter un serveur web séparé.

## Règles métier (déduites du code)

1. Le healthcheck exécute une requête SQL `SELECT 1` directement sur la `DataSource` TypeORM injectée. Si la requête échoue (exception non catchée), NestJS retourne une 500 ; la documentation Swagger annonce un 503 en cas d'inaccessibilité DB.

2. La version déployée est exposée via la variable d'environnement `GIT_SHA`, injectée comme `ARG` Docker lors du build CI/CD à partir du SHA du commit (`github.sha`). Si absente, la valeur `'unknown'` est retournée.

3. Le temps de fonctionnement (`uptime`) est calculé via `process.uptime()`, arrondi en secondes entières.

4. Pour Android App Links, la réponse est un tableau JSON vide si `ANDROID_PACKAGE_NAME` ou `ANDROID_SHA256_FINGERPRINT` ne sont pas définis — ce qui signifie que la fonctionnalité App Links est simplement inactive sans erreur.

5. La variable `ANDROID_SHA256_FINGERPRINT` accepte plusieurs empreintes séparées par des virgules (pour couvrir les cas de certificats de debug et de release).

6. Pour Apple Universal Links, la réponse est un objet JSON vide `{}` si `APPLE_TEAM_ID` ou `APPLE_BUNDLE_ID` sont absents.

7. Quand l'endpoint Apple est actif, les chemins interceptés par l'app iOS sont limités à `/auth/verify*` et `/auth/reset-password*`.

8. Les endpoints `.well-known` sont publics (pas d'authentification) : c'est une exigence imposée par les protocoles Google Digital Asset Links et Apple Associated Domains.

9. Le cache HTTP des endpoints `.well-known` est fixé à 1 heure (`Cache-Control: public, max-age=3600`) pour permettre une rotation rapide des empreintes en cas de changement de certificat.

## Cas d'usage (déduits)

### CU-001 — Vérification de l'état de l'API

Un outil de monitoring (CI/CD, load balancer, Uptime Robot) appelle `GET /health`. L'API interroge la base de données via `SELECT 1` et retourne `{ status: "ok", db: "ok", version: "<sha>", uptime: <secondes> }` avec HTTP 200. Si la DB est inaccessible, l'exception se propage et le monitoring reçoit une 500.

### CU-002 — Activation des Android App Links

Au déploiement initial ou lors d'un renouvellement de certificat Android, le développeur configure `ANDROID_PACKAGE_NAME` et `ANDROID_SHA256_FINGERPRINT` (une ou plusieurs empreintes SHA-256 séparées par des virgules) dans les variables d'environnement. L'application Flutter peut alors ouvrir les liens `https://api.bladeburu.com/...` directement dans l'app sans passer par le navigateur.

### CU-003 — Validation Android App Links

Google vérifie l'endpoint `GET /.well-known/assetlinks.json` via son service Digital Asset Links. La réponse contient la relation `delegate_permission/common.handle_all_urls` associée au `package_name` et aux `sha256_cert_fingerprints` de l'app.

### CU-004 — Préparation iOS Universal Links (futur)

Quand le projet cible iOS, les variables `APPLE_TEAM_ID` et `APPLE_BUNDLE_ID` sont configurées. L'endpoint `GET /.well-known/apple-app-site-association` devient actif et retourne la structure `applinks` avec les chemins `/auth/verify*` et `/auth/reset-password*`.

## Dépendances

- `TypeORM DataSource` — injectée dans `HealthController` pour exécuter `SELECT 1`
- `@nestjs/config ConfigService` — injectée dans `WellKnownController` pour lire les variables d'environnement
- Variables d'environnement runtime : `GIT_SHA`, `ANDROID_PACKAGE_NAME`, `ANDROID_SHA256_FINGERPRINT`, `APPLE_TEAM_ID`, `APPLE_BUNDLE_ID`
- CI/CD (GitHub Actions) — injecte `GIT_SHA` via `--build-arg` Docker au moment du build

## Zones d'incertitude

> Les points suivants n'ont pas pu être déterminés par le code seul :

- Le code Swagger annonce HTTP 503 pour "DB inaccessible", mais l'implémentation laisse propager une exception non catchée (résultat probable : HTTP 500). Est-ce intentionnel ou un oubli d'un bloc `try/catch` avec `throw new ServiceUnavailableException()` ?
- La liste de chemins Apple (`/auth/verify*`, `/auth/reset-password*`) est codée en dur dans le controller. Une évolution vers des chemins configurables via env var est-elle prévue ?
- Aucun test unitaire ou e2e n'existe pour ces deux controllers. Le comportement en cas de panne DB partielle (timeout vs. refus de connexion) n't pas été documenté.
