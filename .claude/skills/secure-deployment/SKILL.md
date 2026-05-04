---
name: secure-deployment
description: Audit complet sécurité + déploiement Manga Tracker API (helmet, throttler, CORS whitelist, synchronize:false, migrations TypeORM, secrets hors git, Dockerfile non-root, .dockerignore, CI/CD) — produit un rapport de gaps + corrections concrètes.
---

# Skill : Secure deployment audit — Manga Tracker API

Audit complet sécurité + déploiement. Produit un rapport des gaps détectés et propose des corrections concrètes.

---

## Étape 1 — Inventaire

Lire :

- `src/main.ts` — bootstrap
- `src/app.module.ts` — modules globaux (throttler, etc.)
- `src/shared/typeorm/typeorm.service.ts` ou data-source — config DB
- `Dockerfile`
- `.dockerignore`
- `.gitignore`
- `src/common/envs/*.env` — vérifier qu'aucune valeur réelle n'est versionnée
- `.github/workflows/*.yml` — CI/CD
- `package.json` — vérifier présence de `helmet`, `@nestjs/throttler`

---

## Étape 2 — Checklist d'audit

### Bootstrap (`main.ts`)

- [ ] `helmet()` appliqué globalement
- [ ] `ValidationPipe` global avec `whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`, `transform`
- [ ] CORS avec whitelist explicite par environnement (pas `app.enableCors()` nu)
- [ ] Swagger désactivé en production (ou auth-protected)

### Throttling

- [ ] `@nestjs/throttler` installé
- [ ] `ThrottlerModule.forRoot()` dans `app.module.ts`
- [ ] `ThrottlerGuard` enregistré comme `APP_GUARD`
- [ ] `@Throttle()` renforcé sur `/auth/login`, `/auth/register`, `/auth/refresh`

### TypeORM

- [ ] `synchronize: false` (ou conditionnel non-prod)
- [ ] Dossier `migrations/` existe et est versionné
- [ ] Scripts `migration:generate`, `migration:run`, `migration:revert` dans `package.json`
- [ ] `migrationsRun: true` en prod ou run via CI/CD avant déploiement

### Secrets

- [ ] Aucun `*.env` (sauf `template.env`) dans git :
  ```bash
  git ls-files | grep -E '\.env($|\..+)' | grep -v template.env
  ```
- [ ] `.gitignore` contient `*.env` et `!template.env`
- [ ] `template.env` ne contient AUCUNE valeur sensible
- [ ] Si secret leaked dans l'historique git → rotation immédiate (regénérer JWT, OAuth, mots de passe)

### Auth

- [ ] `bcrypt.hash` saltRounds ≥ 10
- [ ] Toutes les routes privées : `@UseGuards(AuthGuard('jwt'))`
- [ ] Refresh token strategy distincte (`jwt-refresh`)
- [ ] Pas de JWT secret loggé

### Docker

- [ ] Image basée sur Alpine (ou similaire minimal)
- [ ] Utilisateur non-root (`USER node`)
- [ ] `.dockerignore` exclut `node_modules`, `*.env`, `dist`, `.git`, `*.md` (sauf README)
- [ ] Multi-stage build (builder + runtime)
- [ ] Pas de secrets en build args

### CI/CD

- [ ] Secrets stockés dans GitHub Actions secrets
- [ ] Tests + lint exécutés avant build
- [ ] `npm ci` (pas `npm install`) pour build reproductible
- [ ] Migration TypeORM appliquée avant déploiement
- [ ] Image Docker scannée (Trivy / Snyk si possible)

### Headers / CORS

- [ ] `CORS_ORIGINS` explicite par env (dev / staging / prod)
- [ ] Web futur (origine future) à prévoir dans la whitelist quand le domaine sera connu

---

## Étape 3 — Format du rapport

```markdown
## Audit sécurité & déploiement — [date]

### 🔴 Critique
- [ ] [Gap 1] — [fichier:ligne] — [impact] — **fix** : [action]
- [ ] [Gap 2] — ...

### 🟠 Haute
- [ ] ...

### 🟡 Moyenne
- [ ] ...

### ✅ OK
- [ ] [Élément validé]

### Plan de remédiation
1. [Action prioritaire]
2. [Action suivante]
3. ...
```

---

## Étape 4 — Application des fixes

Si l'utilisateur valide le plan, appliquer les fixes dans cet ordre :

1. `.gitignore` + retrait des `.env` versionnés (rotation des secrets concernés)
2. `synchronize: false` + génération des migrations existantes
3. Helmet + CORS whitelist + Throttler dans `main.ts` / `app.module.ts`
4. `@Throttle()` sur endpoints auth
5. Mise à jour CI/CD (migration:run avant déploiement)
6. `Dockerfile` + `.dockerignore` durcis

Documenter chaque fix dans `.claude/memory-bank/decisions.md` (sections "Décisions Prises" et "Améliorations Identifiées").

---

**Rappel** : la sécurité n'est pas négociable. Un gap critique bloque un déploiement, point.
