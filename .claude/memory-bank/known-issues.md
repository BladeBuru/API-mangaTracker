# Problèmes Connus — Manga Tracker API

**Dernière mise à jour :** Août 2026

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

### Connexion Google web : la popup perdait `window.opener` (COOP de Helmet)
- **Module** : `api/user/auth` (`auth.controller.ts` callback Google, `auth.module.ts`)
- **Résolu le** : 2026-09-05
- **Symptôme** : depuis le client web, la connexion Google « ne marche pas hyper bien » : la popup Google se ferme (ou reste ouverte sur « Connexion réussie ») mais l'application n'est jamais connectée.
- **Cause racine** : `app.use(helmet())` pose `Cross-Origin-Opener-Policy: same-origin` sur toutes les réponses (vérifié en prod : `curl -I https://api.bladeburu.com/auth/google` → `Cross-Origin-Opener-Policy: same-origin`). La popup est ouverte depuis `app.bladeburu.com` (autre origine) ; dès qu'elle reçoit une réponse de l'API portant ce COOP, le navigateur la place dans un nouveau groupe de contextes de navigation et `window.opener` devient `null`. Le script de la page de callback teste `window.opener && !window.opener.closed` → faux → aucun `postMessage` → le client web attend des jetons qui n'arrivent jamais. Ni la CSP (déjà surchargée par un nonce sur cette page) ni la popup elle-même (ouverte sans `noopener`) n'étaient en cause.
- **Solution** : `GoogleOAuthPopupMiddleware` (COOP `unsafe-none`) appliqué via `AuthModule.configure` à `GET /auth/google` et `GET /auth/google/callback` uniquement. Helmet reste strict partout ailleurs. Test unitaire `google-oauth-popup.middleware.spec.ts`.
- **À vérifier après déploiement** : `curl -I https://api.bladeburu.com/auth/google` doit renvoyer `Cross-Origin-Opener-Policy: unsafe-none`, puis connexion Google depuis `app.bladeburu.com` (Chrome, Brave, Safari).

### Cartes de recommandations sans année ni note en étoiles
- **Module** : mangas + recommendations
- **Résolu le** : 2026-08-28 (branche `fix/manga-data-completeness`)
- **Symptôme** : en prod, sur les cartes de recommandations, l'année et la
  note en étoiles n'apparaissaient pas pour une partie des mangas — image
  présente, ligne meta vide. Côté app, `MangaCard` masque volontairement
  toute la ligne meta quand année ET note manquent (comportement voulu) :
  le problème était 100 % côté données API.
- **Cause** : les DTO sont remplis depuis la table locale `manga` avec repli
  `year = manga.year ?? 0` et `rating = manga.rating !== null ? … : 0`, et
  l'app traduit ce `0` en « absent ». Trois causes cumulées laissaient ces
  colonnes à NULL :
  1. **Écrasement par NULL (latente)** — `getMangaDetails` et
     `MangaSyncService` faisaient un `SET` inconditionnel sur
     `year`/`rating`/covers. Un `bayesian_rating: null` MU (titre peu voté)
     écrasait une valeur déjà correctement remplie par la synchro nocturne.
  2. **Stubs jamais complétés (dominante)** — `saveRecommendations` crée des
     stubs `mu_id + title + covers` ; l'endpoint MU « recommendations » ne
     renvoie NI année NI note, donc ils restaient NULL jusqu'au premier clic.
  3. **Rattrapage biaisé (aggravante)** — `hydrateMissingGenres` ne voyait
     que `genres IS NULL` et triait `rating DESC NULLS LAST` : les stubs
     (rating NULL) passaient derrière ~5000 lignes de catalogue, et une
     ligne « genres OK / rating NULL » n'était jamais reprise.
- **Solution** (dans cet ordre) :
  1. Doctrine null-safe généralisée — `buildProtectedColumnsUpdate`
     (`manga-completeness.util.ts`) omet du `SET` toute colonne protégée
     que MU ne fournit pas. Une vraie valeur écrase toujours normalement.
     `PROTECTED_NULLABLE_COLUMNS` devient la source de vérité unique,
     partagée avec `catalog-sync.mapper.ts`.
  2. `hydrateMissingGenres` → `hydrateIncompleteRows` — critère élargi
     (`genres OR rating OR year OR medium_cover_url IS NULL`), tri par
     rating supprimé, priorisation par `EXISTS` dans `manga_recommendation`,
     garde anti-boucle `hydration_attempted_at` (30 j, horodatée après
     chaque tentative même en échec), budget 200 → 800/nuit.
  3. Hydratation à la demande fire-and-forget sur le chemin des recos
     (plafond 8/requête, jamais bloquante, 429 avalé).
- **⚠️ Piège évité** : sans la garde `hydration_attempted_at`, les titres
  pour lesquels MU n'a réellement ni note ni année seraient re-sélectionnés
  chaque nuit et brûleraient tout le budget en boucle. Colonne dédiée
  plutôt que `updated_at < now() - 30 j` : un stub fraîchement créé a un
  `updated_at` récent et serait exclu 30 jours alors que c'est exactement
  la ligne à réparer en priorité.
- **BDD** : migration `1787875200000-AddHydrationAttemptedAtToManga`.
- **Tests** : `manga-completeness.util.spec.ts` (17 cas) + 4 cas
  `mangas.service.spec.ts` + 8 cas `catalog-sync.service.spec.ts` — 153 → 182.

---

### Recos by-genre : mêmes titres dans toutes les sections + doublons
- **Module** : recommendations
- **Résolu le** : 2026-08-25 (branche `fix/recos-by-genre-dedup`)
- **Symptôme** : `GET /recommendations/by-genre` (home segmentée, top 5
  genres × 10) — l'utilisateur avec ~5 recos au total voyait LES MÊMES
  titres dans chaque section (Action, Shounen…), certains en triple.
- **Cause** : les sections n'étaient que des vues filtrées d'un pool global
  unique ; chaque manga était poussé dans TOUTES les sections de ses genres
  (multi-appartenance assumée « UX home »), les « top genres » étaient
  dérivés du pool lui-même, et aucune section n'était complétée. Avec un
  pool maigre (cache MU peu rempli), sections identiques + titres en Nx.
- **Solution** : logique extraite dans `GenreSectionService` — dédup par
  `mu_id` (pool Map + Set par section, genres trimés), exclusivité
  inter-sections (affectation au genre le mieux classé — genres favoris de
  la biblio, fallback pool — avec bascule sur le genre suivant si section
  pleine), complément des sections sous `perGenre` par le catalogue local
  (rating ≥ 7, NSFW exclus, hors biblio, hors affichés, 1 requête max par
  section). Contrat `Map<genre, MangaQuickViewDto[]>` inchangé. Tests :
  `genre-section.service.spec.ts` (10 cas) + spec service adaptée.

---

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
