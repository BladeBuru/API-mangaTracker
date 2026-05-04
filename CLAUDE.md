# CLAUDE.md — Manga Tracker API

> Instructions chargées automatiquement à chaque session Claude Code dans ce projet.
> Migration depuis `.cursor/rules/rules.mdc` (always-on) + `.cursor/rules/a_always-read-docs.mdc` + sections sécurité ajoutées.

---

## 🏗️ Stack technique

- **Framework** : NestJS 9 (module-based)
- **ORM** : TypeORM 0.3 + PostgreSQL (`pg`)
- **Auth** : JWT Passport — AccessToken (court) + RefreshToken (long)
- **Validation** : `class-validator` + `class-transformer`
- **Doc API** : Swagger (`@nestjs/swagger`) sur `/api`
- **Tests** : Jest + Supertest
- **Langue** : TypeScript strict, **pas de `any`**

---

## 📖 Lecture obligatoire avant tout code

**AVANT TOUTE MODIFICATION**, lire dans cet ordre :

1. [.claude/memory-bank/architecture.md](.claude/memory-bank/architecture.md) — Stack, structure modules, patterns
2. [.claude/memory-bank/progress.md](.claude/memory-bank/progress.md) — État d'avancement, ce qui est fait/prévu
3. [.claude/memory-bank/known-issues.md](.claude/memory-bank/known-issues.md) — Bugs actifs et workarounds
4. [.claude/memory-bank/decisions.md](.claude/memory-bank/decisions.md) — Décisions architecturales (lire avant de proposer autre chose)

**Après features majeures** : mettre à jour `progress.md`, et si nécessaire `architecture.md` / `known-issues.md` / `decisions.md`.

**Si architecture incertaine → DEMANDER avant de coder, ne pas deviner.**

---

## 🚫 Interdiction absolue du vibe coding

- ❌ **JAMAIS** de code sans avoir compris l'architecture existante
- ❌ **JAMAIS** de modifications sans lire le memory-bank
- ❌ **JAMAIS** de fichiers monolithiques (controller > 200 lignes, service > 400 lignes)
- ❌ **JAMAIS** de mélange de responsabilités (Controller ≠ Service ≠ Repository)
- ✅ **TOUJOURS** analyser avant d'implémenter
- ✅ **TOUJOURS** respecter la séparation stricte des responsabilités
- ✅ **TOUJOURS** mettre à jour `memory-bank/progress.md` après chaque feature

---

## 🏗️ Principes SOLID (OBLIGATOIRES)

- **Single Responsibility** : Controller = routes HTTP, Service = logique métier, jamais les deux mélangés.
- **Open/Closed** : extension par composition + injection, pas modification.
- **Dependency Inversion** : dépendre d'abstractions, injection via constructeur (`private readonly`).

---

## 📋 Limites strictes

| Type | Limite | Si dépassement |
|------|--------|---------------|
| Controller | 200 lignes | Découper en sous-controllers ou extraire la logique vers le service |
| Service | 400 lignes | Extraire des services spécialisés (ex: `sync-manga.service.ts`) |
| Fichier quelconque | 600 lignes | **CRITIQUE** — découpage immédiat |
| Méthode | 50 lignes | Extraire des méthodes privées |

Voir `/refactor-large-file` (skill) pour le pattern de découpage.

---

## 🛡️ RGPD / Données personnelles (non-négociable)

L'API traite des données personnelles (email, bibliothèque, notes). Toute évolution touchant à `User`, `UserManga`, `UserSession`, ou aux endpoints d'authentification doit respecter :

### Règles absolues
- ❌ **JAMAIS** logger un email, mot de passe (même hashé), token JWT, ou contenu de DTO d'auth.
- ❌ **JAMAIS** retourner le `password` ni le `googleId` d'un User dans une réponse API. Les routes RGPD nettoient explicitement ces champs (voir `gdpr.service.ts`).
- ❌ **JAMAIS** stocker un mot de passe en clair (toujours bcrypt saltRounds ≥ 10).
- ❌ **JAMAIS** envoyer une donnée utilisateur à un service tiers sans l'inclure dans la liste publique des sous-traitants ([legal/PRIVACY_POLICY.md](legal/PRIVACY_POLICY.md) section 4).

### Endpoints RGPD obligatoires
- `GET /user/gdpr/summary` (article 15 — droit d'accès)
- `GET /user/gdpr/export` (article 20 — droit à la portabilité, format JSON)
- `POST /user/gdpr/consent` (consentement éclairé, à appeler à l'inscription)
- `GET /user/gdpr/consent-status` (vérifie si re-consentement nécessaire)
- `DELETE /user/delete` (article 17 — droit à l'effacement, déjà en place avec cascade `onDelete: 'CASCADE'` sur user_manga + user_session)

### Suivi du consentement
- Toute nouvelle version des CGU/Privacy → **incrémenter `CURRENT_TOS_VERSION` ou `CURRENT_PRIVACY_VERSION`** dans `gdpr.service.ts`. Les utilisateurs existants seront invités à re-consentir au prochain login (logique `needsConsentRefresh`).
- Les colonnes `acceptedTosAt`, `acceptedTosVersion`, `acceptedPrivacyAt`, `acceptedPrivacyVersion` sont la **preuve légale** du consentement. Ne jamais les modifier hors flow normal.

### Documents légaux
- `legal/PRIVACY_POLICY.md` — Politique de confidentialité (modèle, à valider par juriste)
- `legal/TERMS_OF_SERVICE.md` — CGU avec décharge de responsabilité (article 7, à valider par juriste)
- À héberger publiquement (URL stable) avant publication de l'app, et lien depuis l'application.

### Rétention
- Logs techniques : 90 jours max.
- Compte supprimé : suppression effective sous 30 jours (purge sauvegardes).
- Sessions révoquées : 7 jours.

### Notification de violation
En cas de violation de données personnelles affectant les droits des utilisateurs : notification CNIL et utilisateurs sous 72h (article 34 RGPD).

---

## 🔒 Sécurité non-négociable (ajout évolution)

Ces règles encodent les durcissements de sécurité prévus pour ce projet. Toute PR qui les viole doit être bloquée.

### TypeORM
- ❌ `synchronize: true` **INTERDIT** en production. La valeur doit être `process.env.NODE_ENV !== 'production'` ou false par défaut.
- ✅ Migrations TypeORM obligatoires (`dist/migrations/*.js`) — script `npm run migration:generate` / `migration:run`.
- ✅ Vérifier que le dossier `migrations/` existe et est versionné.

### Secrets & environnement
- ❌ **JAMAIS** de fichier `*.env` versionné (sauf `template.env` sans valeurs réelles).
- ❌ Pas de JWT_KEY, JWT_REFRESH_SECRET, GOOGLE_CLIENT_SECRET, DB_PASSWORD en clair dans le repo.
- ✅ `.gitignore` doit contenir `*.env`, `!template.env`.
- ✅ Secrets injectés via variables d'environnement (CI/CD secrets, Docker secrets, etc.).

### Bootstrap `main.ts`
Toute config `main.ts` doit inclure :
- ✅ `helmet()` — headers de sécurité (CSP, HSTS, X-Frame-Options).
- ✅ `@nestjs/throttler` configuré globalement, avec rate-limit explicite renforcé sur `/auth/login`, `/auth/register`, `/auth/refresh`.
- ✅ CORS avec **whitelist explicite par environnement** (pas `app.enableCors()` nu). Domaines autorisés : front mobile, front web futur, admin éventuel.
- ✅ `ValidationPipe` global avec `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`.

### Auth
- ✅ `bcrypt` saltRounds ≥ 10.
- ✅ Toutes les routes privées : `@UseGuards(AuthGuard('jwt'))`.
- ✅ Refresh token stocké côté client en stockage sécurisé (`flutter_secure_storage` côté Flutter).
- ✅ Ne jamais logger un token, secret, ou mot de passe (en clair ou hashé).

### Docker
- ✅ Image basée sur Alpine, utilisateur non-root.
- ✅ `.dockerignore` exclut `node_modules`, `*.env`, `dist`, `.git`.

---

## 🌐 Évolution prévue : déploiement multi-clients

Le front Flutter cible Android (actuel), iOS (à venir), Web (à venir). L'API doit en tenir compte :

- **CORS** : whitelist par env qui inclut le domaine web de production quand il existera.
- **Versioning d'API** : prévoir `/v1/...` si rupture future (clients mobiles à mettre à jour).
- **Réponses cohérentes** : pas de breaking change sans bump de version.

---

## 🧰 Skills disponibles

Invocables via Skill tool ou en demandant explicitement :

- **feature-implementation** — Workflow 6 phases pour implémenter une nouvelle feature ([.claude/skills/feature-implementation/SKILL.md](.claude/skills/feature-implementation/SKILL.md))
- **bug-fix** — Workflow 4 phases pour investiguer + corriger + documenter un bug ([.claude/skills/bug-fix/SKILL.md](.claude/skills/bug-fix/SKILL.md))
- **refactor-large-file** — Découpage de fichier dépassant les seuils ([.claude/skills/refactor-large-file/SKILL.md](.claude/skills/refactor-large-file/SKILL.md))
- **secure-deployment** — Audit complet sécurité + déploiement (helmet, throttler, CORS, synchronize, secrets, Docker) ([.claude/skills/secure-deployment/SKILL.md](.claude/skills/secure-deployment/SKILL.md))

---

## 📚 Documentation technique

Consulter selon le besoin :

- [.claude/docs/architecture.md](.claude/docs/architecture.md) — Stack, structure modules, configuration
- [.claude/docs/modules-structure.md](.claude/docs/modules-structure.md) — Patterns détaillés par module
- [.claude/docs/api-contracts.md](.claude/docs/api-contracts.md) — Endpoints, DTOs, codes HTTP, format réponses
- [.claude/docs/authentication.md](.claude/docs/authentication.md) — Flux JWT, stratégies Passport, guards

---

## 🪝 Hooks actifs

Voir [.claude/settings.json](.claude/settings.json). Les hooks injectent automatiquement les standards adaptés selon le fichier édité :

- Édition d'un `*.controller.ts` → standards controller injectés.
- Édition d'un `*.dto.ts` ou `dto/*.ts` → standards validation DTO injectés.
- Édition de `main.ts` → checklist sécurité bootstrap injectée.
- Édition d'un `typeorm.service.ts` ou `data-source*.ts` → règles `synchronize:false` + migrations.
- Édition d'un `*.env*` → garde-fou secrets (rappel `.gitignore`, pas de valeurs réelles).

---

## 🎯 En cas d'ambiguïté

- **Si tu ne comprends pas un besoin → DEMANDE avant de coder**
- **Si le module n'est pas clair → LIS [.claude/memory-bank/architecture.md](.claude/memory-bank/architecture.md)**
- **Si pattern incertain → APPLIQUE le standard Controller/Service**
