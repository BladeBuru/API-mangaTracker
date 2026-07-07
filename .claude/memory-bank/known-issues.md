# Problèmes Connus — Manga Tracker API

**Dernière mise à jour :** Mai 2026

---

## 🐛 Problèmes Actifs (sécurité — détectés à l'évolution)

### `synchronize: true` en TypeORM
- **Module** : shared/typeorm
- **Sévérité** : 🔴 Critique (en production)
- **Découvert le** : 2026-05
- **Statut** : Actif

**Description** : `typeorm.service.ts` utilise `synchronize: true`, ce qui auto-synchronise le schéma DB au démarrage. En prod, peut causer perte de données ou schéma incohérent.

**Impact** : Risque de schema drift, perte de données silencieuse en cas de modification d'entité.

**Solution** : Passer à `synchronize: false` (ou conditionnel non-prod), créer le dossier `migrations/`, ajouter scripts `migration:generate` / `migration:run`, générer les migrations rétroactivement pour le schéma actuel. Voir `.claude/skills/secure-deployment/SKILL.md`.

---

### Secrets versionnés dans `development.env`
- **Module** : common/envs
- **Sévérité** : 🔴 Critique
- **Découvert le** : 2026-05
- **Statut** : Actif

**Description** : `src/common/envs/development.env` contient JWT_KEY, JWT_REFRESH_SECRET, GOOGLE_CLIENT_SECRET en clair, et est versionné dans git.

**Impact** : Toute personne avec accès au repo a les secrets. Si secrets utilisés en prod (même par erreur), compromission complète.

**Solution** :
1. Retirer le fichier de git : `git rm --cached src/common/envs/development.env`
2. Ajouter `*.env` (sauf `template.env`) au `.gitignore`
3. **Rotation immédiate** des secrets concernés (regénérer JWT_KEY, JWT_REFRESH_SECRET, regénérer le client Google OAuth)
4. Vérifier l'historique git pour s'assurer qu'aucune autre version n'a été committée
5. Documenter la procédure de rotation dans `decisions.md`

---

### Pas de rate limiting (`@nestjs/throttler` absent)
- **Module** : main.ts / app.module.ts
- **Sévérité** : 🟠 Haute
- **Découvert le** : 2026-05
- **Statut** : Actif

**Description** : Aucun throttler configuré. `/auth/login` peut être brute-forcé sans limite côté serveur.

**Solution** : Installer `@nestjs/throttler`, configurer un throttler global (100 req/min), `@Throttle()` renforcé sur `/auth/login` (5/min), `/auth/register` (5/min), `/auth/refresh` (10/min).

---

### Pas de helmet
- **Module** : main.ts
- **Sévérité** : 🟠 Haute
- **Découvert le** : 2026-05
- **Statut** : Actif

**Description** : Aucun header de sécurité HTTP (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, etc.).

**Solution** : Installer `helmet` et appliquer `app.use(helmet())` dans `main.ts`.

---

### CORS dev-only / pas de whitelist prod
- **Module** : main.ts
- **Sévérité** : 🟡 Moyenne
- **Découvert le** : 2026-05
- **Statut** : Actif

**Description** : `app.enableCors()` activé seulement en `NODE_ENV === 'development'`, sans whitelist explicite. Pas prêt pour le front web futur.

**Solution** : Whitelist par env via `CORS_ORIGINS` (séparées par virgules), `credentials: true`. Voir `.claude/rules/nest-main-security.md`.

---

## ✅ Problèmes Résolus

### Recherche : `orderby: 'rating'` écrasait la pertinence MangaUpdates
- **Module** : mangas
- **Résolu le** : 2026-07-03
- **Symptôme** : « Shadow System: Harnessing… » (1er sur mangaupdates.com)
  introuvable via `POST /mangas/search` ; « Naruto » mal classé ; 20 résultats
  max sans pagination exploitable.
- **Cause** : le payload MU envoyait `orderby: 'rating'` → MU triait les
  milliers de matches flous par note globale au lieu de la pertinence (son
  défaut `score` = classement du site). Les titres de niche sortaient du
  top-60 téléchargé et le re-tri local (`bonus startsWith/exact`) ne pouvait
  pas repêcher un titre absent de l'échantillon. `page`/`perpage` avaient de
  plus une sémantique cassée (`perpage = limit*3`, re-tri + `slice(0,20)` par
  page → 40 résultats sur 60 jamais servables).
- **Solution** : pas d'`orderby` (défaut MU = pertinence, vérifié le 2026-07-03 :
  les deux cas sortent en #1), pas de re-tri local, `perpage = limit` (borné
  1-100, max MU), `page` 1-indexée. Réponse = enveloppe `{results, totalHits,
  page, perPage, hasMore}` si `page` fourni, tableau nu sinon (rétrocompat
  clients ≤ 0.11.0). Tests : `mangas.service.spec.ts` (8 cas searchManga).

---

## ⚠️ Workarounds Temporaires

_(Documenter les contournements en attente de solution définitive)_

---

## 💡 Améliorations Identifiées

- Versioning API (`/v1/...`) à introduire avant le premier breaking change
- Tests : étendre la couverture sur `auth/` (chemin critique)
- Image Docker : scanner avec Trivy/Snyk avant push registry
- Rotation des secrets JWT : mécanisme `kid` header

---

## 📋 Format d'un problème

```
### [Titre court]

- **Module** : [mangas | library | user | auth | infra]
- **Sévérité** : [Critique | Haute | Moyenne | Basse]
- **Découvert le** : AAAA-MM-JJ
- **Statut** : [Actif | En cours | Résolu]

**Description** : Explication claire.

**Reproduction** :
1. Étape 1
2. Étape 2

**Impact** : Ce que ça casse.

**Solution / Workaround** : Ce qui est fait ou prévu.
```
