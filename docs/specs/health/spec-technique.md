# Spec Technique — Health & Well-Known

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | health              |
| Version       | 0.1.0               |
| Date          | 2026-06-04          |
| Source        | Rétro-ingénierie    |

## Architecture du module

La feature regroupe deux modules NestJS indépendants, sans service dédié : toute la logique est directement dans les controllers (justifié par la faible complexité).

**HealthModule** (`src/health/`) :
- Un seul controller `HealthController` qui injecte la `DataSource` TypeORM via `@InjectDataSource()`.
- Aucun service applicatif ; la vérification DB est une requête raw inline.
- `TypeOrmModule.forFeature([])` est importé mais ne déclare aucune entité (probablement pour garantir que le module attende l'initialisation TypeORM).

**WellKnownModule** (`src/api/well-known/`) :
- Un seul controller `WellKnownController` qui injecte `ConfigService` pour lire les variables d'environnement.
- Importation de `ConfigModule` dans le module.
- Aucun provider applicatif.

Les deux modules sont enregistrés dans le module racine `AppModule`.

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/health/health.controller.ts` | Endpoint `GET /health` — vérification DB + exposition version | ~33 |
| `src/health/health.module.ts` | Déclaration module NestJS, import TypeOrmModule | ~9 |
| `src/api/well-known/well-known.controller.ts` | Endpoints `GET /.well-known/assetlinks.json` et `GET /.well-known/apple-app-site-association` | ~109 |
| `src/api/well-known/well-known.module.ts` | Déclaration module NestJS, import ConfigModule | ~17 |
| `Dockerfile` | Injection de `GIT_SHA` et `BUILD_DATE` comme ARG Docker → ENV | ~3 lignes concernées |
| `.github/workflows/ci-cd.yml` | Passage de `GIT_SHA=${{ github.sha }}` au `docker build` | ~1 ligne concernée |

## Schéma BDD

Aucun accès à une entité TypeORM. La seule interaction DB est la requête raw `SELECT 1` dans `HealthController.check()`.

## API / Endpoints

| Méthode | Route | Description | Auth |
|---------|-------|-------------|------|
| `GET` | `/health` | Healthcheck — DB + version Git + uptime | Public |
| `GET` | `/.well-known/assetlinks.json` | Android App Links — Digital Asset Links statement | Public |
| `GET` | `/.well-known/apple-app-site-association` | Apple Universal Links — App Site Association | Public |

### Réponse `GET /health` (HTTP 200)

```json
{
  "status": "ok",
  "db": "ok",
  "version": "bf0d423",
  "uptime": 3724
}
```

| Champ | Type | Description |
|-------|------|-------------|
| `status` | `"ok"` | Toujours `"ok"` si la requête aboutit |
| `db` | `"ok"` | Toujours `"ok"` si `SELECT 1` réussit |
| `version` | `string` | Valeur de `process.env.GIT_SHA` ou `"unknown"` |
| `uptime` | `number` | `Math.floor(process.uptime())` en secondes |

### Réponse `GET /.well-known/assetlinks.json`

Retourne `[]` si `ANDROID_PACKAGE_NAME` ou `ANDROID_SHA256_FINGERPRINT` sont absents/vides.

Sinon :
```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.example.manga_tracker",
      "sha256_cert_fingerprints": ["AA:BB:CC:..."]
    }
  }
]
```

### Réponse `GET /.well-known/apple-app-site-association`

Retourne `{}` si `APPLE_TEAM_ID` ou `APPLE_BUNDLE_ID` sont absents.

Sinon :
```json
{
  "applinks": {
    "apps": [],
    "details": [
      {
        "appID": "TEAMID.com.example.bundle",
        "paths": ["/auth/verify*", "/auth/reset-password*"]
      }
    ]
  }
}
```

## Variables d'environnement consommées

| Variable | Utilisée dans | Fallback | Description |
|----------|---------------|---------|-------------|
| `GIT_SHA` | `HealthController` | `"unknown"` | SHA du commit, injecté par Docker build-arg depuis la CI |
| `ANDROID_PACKAGE_NAME` | `WellKnownController` | (désactive l'endpoint) | Nom du package APK Android |
| `ANDROID_SHA256_FINGERPRINT` | `WellKnownController` | (désactive l'endpoint) | Empreintes SHA-256 du certificat, séparées par virgules |
| `APPLE_TEAM_ID` | `WellKnownController` | (désactive l'endpoint) | Team ID Apple Developer |
| `APPLE_BUNDLE_ID` | `WellKnownController` | (désactive l'endpoint) | Bundle ID iOS |

## Injection de GIT_SHA (pipeline CI/CD)

Le SHA Git est injecté à la construction de l'image Docker :

1. GitHub Actions extrait `github.sha` et le passe en `--build-arg GIT_SHA=<sha>`.
2. Le `Dockerfile` déclare `ARG GIT_SHA=unknown` puis `ENV GIT_SHA=${GIT_SHA}`.
3. L'image résultante contient `GIT_SHA` en variable d'environnement de processus.
4. `HealthController` lit `process.env.GIT_SHA` à chaque appel.

Ce mécanisme est statique (fixé au build), non dynamique (pas de lecture de `git rev-parse` au runtime).

## Patterns identifiés

- **Thin controller sans service** : pattern acceptable pour des endpoints purement utilitaires sans logique métier réutilisable.
- **Configuration déportée via env vars** : les valeurs liées à la plateforme (package name, fingerprints, team ID) sont externalisées — aucune valeur de configuration mobile n'est codée en dur, sauf les chemins Apple.
- **Dégradation silencieuse** : si les variables d'environnement `.well-known` sont absentes, les endpoints retournent des réponses vides plutôt qu'une erreur — ce qui désactive la fonctionnalité sans faire crasher l'API.
- **Headers HTTP explicites** : `Content-Type: application/json` et `Cache-Control: public, max-age=3600` posés via `@Header()` au niveau du decorateur NestJS.

## Décisions techniques notables (non-ADR)

Ces points ont été évalués pour la création d'un ADR et rejetés (voir rapport ADR). Ils sont documentés ici pour référence :

- **Healthcheck raw SQL vs. `@nestjs/terminus`** : le projet utilise une requête `SELECT 1` inline plutôt que le module `@nestjs/terminus`. Ce choix est confiné au module `health` (Q3=NON) et est immédiatement visible dans le code.
- **`.well-known` servi par l'API NestJS** : plutôt que par un serveur web (nginx, Cloudflare Worker). Décision de déploiement confinée à ce module (Q3=NON).
- **Chemins Apple codés en dur** : `/auth/verify*` et `/auth/reset-password*` sont définis en dur dans le controller, non configurables via env. Détail d'implémentation local.

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|---------------|--------|
| — | HealthController | Absent |
| — | WellKnownController | Absent |
