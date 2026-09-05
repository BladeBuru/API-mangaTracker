# Spec Technique — Recommendations

| Champ         | Valeur                                                                                  |
|---------------|-----------------------------------------------------------------------------------------|
| Module        | recommendations                                                                         |
| Version       | 0.3.0                                                                                   |
| Date          | 2026-08-26                                                                              |
| Source        | Rétro-ingénierie + feat/recos-chapitres-traductions + fix/recos-by-genre-dedup (corrections revue adversariale) |

---

## Architecture du module

Le module est composé d'un controller NestJS pur (HTTP routing), d'un service principal portant la logique de scoring, et de deux services spécialisés : `CatalogCandidateService` (candidats catalogue pour la liste plate) et `GenreSectionService` (sections de la home segmentée — extrait le 2026-08-25 avec le fix « mêmes titres dans toutes les sections »). Aucune couche repository dédiée : les accès BDD passent directement par les repositories TypeORM injectés.

```
RecommendationController
  └─ RecommendationService
       ├─ buildUserRecommendations()        ← endpoint principal, paginé
       ├─ buildUserRecommendationsByGenre() ← home segmentée (cache + délégation)
       │    └─ GenreSectionService
       │         ├─ buildSections()         ← dédup + exclusivité + complément
       │         ├─ rankGenres()            ← top genres biblio (fallback pool)
       │         ├─ findCatalogFillers()    ← complément catalogue par section
       │         └─ buildDtos()             ← assemblage + enrichissement
       ├─ findSleeperHits()                 ← pépites récentes
       ├─ buildColdStartRecommendations()   ← fallback biblio vide
       ├─ buildTopCommunityDtos()           ← top notes locales
       ├─ computeScoreMap()                 ← pool scoré + biblio (by-genre)
       ├─ scoreRecos()                      ← accumulation du scoreMap
       ├─ augmentWithCatalog()              ← complément pool (CatalogCandidateService)
       ├─ computeMultiplier()               ← statut × récence × note
       ├─ buildDtoFromScoreMap()            ← assemblage final + enrichissement
       └─ fetchUncachedInBackground()       ← fire-and-forget fetch MU
```

**Dépendances injectées (`RecommendationService`) :**
- `Repository<UserManga>` — bibliothèque de l'utilisateur
- `Repository<MangaRecommendation>` — pool de recommandations MU
- `Repository<Manga>` — métadonnées mangas (genres, covers, year, rating)
- `MangasService` — cache/fetch MU + note agrégée bayésienne
- `RecoCacheService` — cache user-level (TTL 1h)
- `CatalogCandidateService` / `GenreSectionService` — services spécialisés

L'interface `ScoredEntry` (score + sources) est partagée via `scored-entry.interface.ts` pour éviter un cycle d'import entre `RecommendationService` et `GenreSectionService`.

---

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/recommendations/recommendation.service.ts` | Logique de scoring, cold start, sleepers | ~827 |
| `src/api/recommendations/genre-section.service.ts` | Sections by-genre : dédup, exclusivité, complément catalogue | ~352 |
| `src/api/recommendations/catalog-candidate.service.ts` | Candidats catalogue (liste plate) | ~200 |
| `src/api/recommendations/scored-entry.interface.ts` | Interface `ScoredEntry` partagée | ~13 |
| `src/api/recommendations/recommendation.controller.ts` | Routes HTTP, parsing query params | ~128 |
| `src/api/recommendations/recommendation.module.ts` | Déclaration NestJS, imports TypeORM | ~28 |
| `src/api/recommendations/recommendation.service.spec.ts` | Tests unitaires Jest | ~980 |
| `src/api/recommendations/genre-section.service.spec.ts` | Tests unitaires by-genre (fix 2026-08-25) | ~400 |
| `src/api/mangas/manga-recommendation.entity.ts` | Entité `manga_recommendation` | ~33 |
| `src/api/recommendations/dismissal.service.ts` | Rejets « pas intéressé / déjà vu » + **source unique des mu_id exclus** | ~176 |
| `src/api/recommendations/dismissal.controller.ts` | Routes de rejet / annulation / liste | ~104 |
| `src/api/recommendations/dismissal.module.ts` | Micro-module autonome (importable sans cycle) | ~29 |
| `src/api/recommendations/dismissal-throttler.guard.ts` | Rate-limit 60/h **par utilisateur** | ~64 |
| `src/api/recommendations/dismissal-reason.enum.ts` | Enum applicatif des raisons | ~35 |
| `src/api/recommendations/user-manga-dismissal.entity.ts` | Entité `user_manga_dismissal` | ~70 |
| `src/api/recommendations/dto/dismiss-manga.dto.ts` | DTO d'entrée + DTO de sortie | ~57 |
| `src/api/recommendations/dismissal.service.spec.ts` | Tests unitaires des rejets | ~215 |

---

## Schéma BDD

### Table `manga_recommendation`

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | integer | PK, auto-increment | |
| `source_mu_id` | bigint | NOT NULL | ID MU du manga source |
| `recommended_mu_id` | bigint | NOT NULL | ID MU du manga recommandé |
| `recommended_title` | varchar | nullable | Titre dénormalisé (évite un JOIN) |
| `weight` | integer | NOT NULL | Poids MU (échelle 1-10) |
| `updated_at` | timestamp | auto-updated | Date de mise à jour |

**Index unique** : `(source_mu_id, recommended_mu_id)`

### Table `user_manga_dismissal`

Rejets « pas intéressé / déjà vu ». Détail complet des colonnes et index :
`docs/architecture/database/schema.md`.

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | integer | PK, auto-increment | |
| `user_id` | integer | FK → `user(id)` CASCADE | |
| `manga_id` | bigint | FK → `manga(mu_id)` CASCADE | |
| `reason` | varchar(32) | NOT NULL | `already_read` / `not_interested` / `seen_elsewhere` |
| `created_at` | timestamp | NOT NULL | |

**Index unique** : `(user_id, manga_id)` — porte l'upsert `ON CONFLICT DO UPDATE`.
**Index** : `(user_id)` — lu à chaque calcul de recos.

### Tables lues (pas modifiées par ce module)

- `user_manga` — bibliothèque (champs lus : `user_rating`, `readingStatus`, `adding_date`, `manga_id`)
- `manga` — métadonnées (champs lus : `mu_id`, `title`, `year`, `rating`, `genres`, `medium_cover_url`)

---

## API / Endpoints

| Méthode | Route | Description | Auth | Query params |
|---------|-------|-------------|------|-------------|
| `GET` | `/recommendations` | Recos personnalisées paginées | JWT | `limit` (déf. 50, max 500), `offset` (déf. 0), `genre?` |
| `GET` | `/recommendations/by-genre` | Map genre → recos | JWT | `topGenres` (déf. 5), `perGenre` (déf. 10) |
| `GET` | `/recommendations/sleepers` | Sleeper hits récents | JWT | `limit` (déf. 20, max 500) |
| `POST` | `/recommendations/dismissals/:muId` | Écarter un titre (body : `{ reason }`) | JWT + throttle 60/h/user | — |
| `DELETE` | `/recommendations/dismissals/:muId` | Annuler un rejet (204) | JWT + throttle 60/h/user | — |
| `GET` | `/recommendations/dismissals` | Titres écartés, du plus récent au plus ancien | JWT | — |


---

## Constantes de configuration

| Constante | Valeur | Rôle |
|-----------|--------|------|
| `STATUS_MULTIPLIER` | `{ completed: 1.5, caughtUp: 1.3, reading: 1.2, readLater: 0.8 }` | Poids selon statut de lecture |
| `RECENCY_HALF_LIFE_DAYS` | 365 | Demi-vie de pertinence en jours |
| `MAX_RECOS_PER_SOURCE` | 40 | Cap normal de recos par manga source (10 → 30 → 40) |
| `CATALOG_MIN_POOL` | 150 | Seuil pool MU sous lequel `augmentWithCatalog` est déclenché |
| `MAX_LIMIT` | 500 | Limite max pagination |
| `COLD_START_MIN_VOTES` | 5 | Votes locaux min pour le top communauté |
| `COLD_START_SLEEPER_BUDGET` | 30 | Sleepers max en cold start |
| `BATCH_SIZE` | 5 | Taille des batchs de fetch MU bloquant |
| `FETCH_TIMEOUT_MS` | 15 000 | Timeout par fetch MU (ms) |
| `BATCH_DELAY_MS` | 1 000 | Pause inter-batch fetch bloquant (ms) |
| `RATE_LIMIT_DELAY_MS` | 5 000 | Pause si MU répond 429 avant le batch suivant (ms) |
| `MARKED_PREFERENCE_SHARE` (type-profile) | 0.6 | Part dominante à partir de laquelle la préférence de type est « marquée » |
| `MIN_KNOWN_COVERAGE` (type-profile) | 0.5 | Sous ce taux de bibliothèque typée, le profil est ignoré |
| `UNKNOWN_PENALTY` (type-profile) | 0.5 | Facteur sur la part des types inconnus si préférence marquée |
| `DISCOVERY_SHARE` (type-profile) | 0.05 | Part réservée aux types hors profil présents dans le pool |
| `MIN_BUCKET_LIMIT` (type-profile) | 10 | Plancher de lignes par bucket de requête typé |

**Constantes supprimées** (hotfix → feat/recos-chapitres-traductions) :
- `ADAPTIVE_FALLBACK_CAP` (80) — ancien cap de relax adaptatif, no-op prouvé
- `MIN_POOL_BEFORE_RELAX` (50) — seuil de déclenchement du relax adaptatif

---

## Type de publication : profil et sélection au prorata (2026-09-05)

**Bug corrigé** : un lecteur dont la bibliothèque est à 73 % manhwa (mesuré en prod, ids masqués) ne recevait QUE des mangas — le scoring et les requêtes catalogue ne connaissaient pas le format (aucune colonne `type` avant la migration `1788220800000`).

`type-profile.ts` (pur, testé seul) :

| Fonction | Rôle |
|----------|------|
| `computeTypeProfile(userMangas)` | Part pondérée de chaque type connu (poids = `STATUS_WEIGHT` × note perso / 5, **sans** décroissance temporelle : le goût pour un format est stable). Profil vide (comportement historique) si aucun type connu ou si moins de 50 % (pondéré) de la bibliothèque est typée. `marked` = part dominante ≥ 60 % |
| `interleaveByTypeMix(items, typeOf, profile)` | Réordonne une liste triée par score : round-robin à déficit — à chaque position, le bucket le plus en retard sur sa part cible est émis ; à égalité le meilleur score. Tout préfixe respecte ≈ les parts, **jamais zéro** tant qu'il reste un candidat, ordre par score conservé dans un type, bucket épuisé → slots aux autres. Inconnus (type NULL) : part réelle dans la liste × 0,5 si préférence marquée. Découverte : 5 % pour les types hors profil présents |
| `planTypeQueryBuckets` / `fetchByTypeBuckets` | Un budget de requête catalogue par bucket (`type = T` au prorata, plancher 10 ; `type IS NULL` 35 % si marquée sinon 50 % ; autres types 10 %) — sans profil, une seule requête sans filtre |

Application (le profil est calculé une fois par requête depuis `userMangas`) :

| Chemin | Où |
|--------|----|
| `GET /recommendations` | `RecommendationDtoBuilderService.build` : interleave sur le pool scoré **avant** la pagination → ordre global déterministe, pages sans trou ni doublon (mis en cache par `RecoCacheService`) |
| `GET /recommendations/by-genre` | `GenreSectionService.buildSections` : éligibles d'une section interleavés puis plafonnés à `perGenre` ; compléments catalogue par bucket de type puis interleavés |
| `GET /recommendations/sleepers` | `SleeperHitsService.findSleeperHits` : interleave sur les candidats scorés avant `limit` |
| Candidats catalogue | `CatalogCandidateService.findCandidates` : requêtes par bucket, interleave avant le plafond `maxCandidates` |

Cold start : neutre (aucun signal personnel).

**Découpage (limite 600 lignes)** : `recommendation.service.ts` 889 → 526 lignes — `SleeperHitsService` (sleepers + cold start + top communauté, délégué par `RecommendationService.findSleeperHits`) et `RecommendationDtoBuilderService` (pool scoré → cartes). Contrat du controller inchangé.

---

## Algorithmes et heuristiques

### Multiplicateur d'un manga source (`computeMultiplier`)

```
multiplier = (user_rating / 5.0 si noté, sinon 1.0)
           × STATUS_MULTIPLIER[readingStatus]   (1.0 si inconnu)
           × exp(-ageDays / 365)
```

Où `ageDays = (now - adding_date) / 86_400_000`.

### Score d'accumulation (`scoreRecos`)

Pour chaque `MangaRecommendation` issue du manga source (triées par `weight` desc, tronquées à `MAX_RECOS_PER_SOURCE=40`) :

```
if (recommended_mu_id IN libraryMuIds) → skip
contribution = reco.weight × multiplier
scoreMap[recommended_mu_id].score += contribution
scoreMap[recommended_mu_id].sources[sourceMuId] += contribution
```

### Fetch MU bloquant batché (`fetchAndScoreBlocking`)

Factorisation des deux anciennes boucles dupliquées. Batches de `BATCH_SIZE=5`. Pause `BATCH_DELAY_MS` (1 s) entre chaque batch. Si au moins un manga du batch retourne `MuRateLimitException` (429 MU), la pause est portée à `RATE_LIMIT_DELAY_MS` (5 s) avant le batch suivant. Erreur non-429 → warn + skip silencieux.

### Top-up catalogue (`augmentWithCatalog`)

Déclenché si `scoreMap.size < CATALOG_MIN_POOL` (150). Appelle `CatalogCandidateService.findCandidates`.

**Règle de fusion non-additive** : un `mu_id` déjà présent dans le scoreMap (scoré par MU) n'est jamais réécrit. Seuls les nouveaux candidats (absents du scoreMap et de la bibliothèque) sont insérés. Le score MU prime toujours.

### Score sleeper (`findSleeperHits`)

```
aggregated = aggregatedRating (bayésien) ou rating MU si pas de votes locaux
localCount = nombre de votes locaux
recencyBoost = exp(-(currentYear - manga.year) / 2)
score = aggregated × log(localCount + 2) × recencyBoost
```

Filtres préalables : `year >= currentYear - 2`, `rating >= 7.5`, occurrences dans `manga_recommendation` < 5.

### Sections by-genre (`GenreSectionService.buildSections` — fix 2026-08-25)

Ancien comportement (bogué) : chaque manga du pool était poussé dans TOUTES
les sections correspondant à ses genres, les « top genres » étant dérivés du
pool lui-même. Avec un pool maigre (~5 titres en prod), toutes les sections
affichaient les mêmes titres, certains en triple. Nouveau pipeline :

1. **Pool** : `scoreMap` trié par score desc (dédup par `mu_id` structurelle,
   le pool est un `Map`).
2. **Classement des genres** (`rankGenres`) : genres favoris de la biblio par
   occurrences décroissantes (pattern `computeGenreShares`), complétés par
   les genres les plus représentés dans le pool si < `topGenres` (fallback
   utile quand la biblio ne contient que des stubs sans genres). Égalités
   départagées alphabétiquement (déterminisme). Genres NSFW exclus (union
   `NSFW_GENRES` + ancienne liste inline : Mature, Yaoi, Yuri, Ecchi).
3. **Affectation exclusive** : les sections sont remplies dans l'ordre du
   classement ; un manga est affecté à la première section dont il porte le
   genre (`Set assigned` global) — il n'apparaît que dans UNE section. S'il
   ne rentre pas dans sa meilleure section (pleine), il reste candidat pour
   ses genres suivants. Genres comparés après `trim()` + dédup (`Set`),
   robuste aux données sales type `['Action', 'Action ']`.
4. **Complément catalogue** : chaque section sous `perGenre` est complétée
   par une requête catalogue portant CE genre (pattern
   `CatalogCandidateService`) : `rating ≥ 7.0`, aucun genre NSFW, hors
   biblio, hors titres déjà affichés (exclusions cumulées entre sections),
   tri rating desc, `LIMIT = déficit`. Au plus une requête par section
   déficitaire (≤ `topGenres` requêtes), pas de N+1. Panne catalogue →
   warn + section servie avec ses titres pool.
5. **Assemblage** : titres pool (score desc) puis compléments (rating desc),
   dédup défensive par section, sections vides omises. Enrichissement
   communautaire en un seul appel `getCommunityRatings` pour tous les titres
   affichés ; `recommendedBecauseOf` (top 3 sources) sur les titres pool
   uniquement.

Contrat de réponse inchangé : `Record<genre, MangaQuickViewDto[]>` (consommé
tel quel par le front Flutter). Cache user-level `byGenre:{topGenres}:{perGenre}`
inchangé (TTL 1h, invalidation sur mutation biblio).

---

## Exclusion des titres écartés (« pas intéressé / déjà vu »)

Le besoin : *« On me recommande One Piece et Naruto. Les deux, c'est les meilleurs,
les plus connus. Sauf que moi je les ai — j'adore, mais je les ai vus en animé et je
n'ai pas forcément envie de les relire. »* Aucun algorithme ne peut déduire ça :
l'information n'existe ni dans MangaUpdates, ni dans la bibliothèque, ni dans les notes.
Elle doit être captée explicitement.

### Principe : un seul point d'entrée

Le module comportait **six** endroits construisant leur propre exclusion de la
bibliothèque. Ajouter un filtre à chacun aurait garanti d'en oublier un — et un titre
écarté qui réapparaît vide la fonctionnalité de son sens. Le choix retenu est donc
d'**élargir le set d'exclusion existant à la source** plutôt que d'ajouter un filtre
en aval :

```
DismissalService.buildExclusionSet(userId, libraryMuIds) → Set = biblio ∪ rejets
```

Ce set remplace l'ancien `libraryMuIds` (renommé `excludedMuIds` dans tout
`recommendation.service.ts`) et se propage **inchangé** dans toutes les branches
descendantes qui l'utilisaient déjà. Aucune de ces branches n'a eu besoin d'être
modifiée pour tenir compte des rejets.

### Inventaire exhaustif des chemins

| # | Chemin | Point d'application |
|---|--------|---------------------|
| 1 | `GET /recommendations` (liste plate) | `buildUserRecommendations` → `buildExclusionSet` → `scoreRecos` |
| 2 | Cold start, top communauté | `buildTopCommunityDtos(maxRows, excludedMuIds)` — filtre les `mu_id` remontés |
| 3 | Cold start, sleepers | `buildColdStartRecommendations` transmet le **vrai** `userId` (était `-1`) |
| 4 | `GET /recommendations/sleepers` | `findSleeperHits` → `NOT IN (:...lib)` en SQL |
| 5 | `GET /recommendations/by-genre` (pool) | `computeScoreMap` → `buildExclusionSet` → `scoreRecos` |
| 6 | `GET /recommendations/by-genre` (compléments catalogue) | set transmis en 5e argument à `GenreSectionService.buildSections`, qui ne le reconstruit plus |
| 7 | Candidats catalogue | `augmentWithCatalog` → `CatalogCandidateService.findCandidates(userMangas, excludedMuIds)` → `NOT IN` SQL |
| 8 | `GET /mangas/recommendations/:muId` (fiche détail) | `getRecommendationsAsQuickView(muId, userId)` filtre après le merge MU + communauté |

**Comment l'exhaustivité a été établie :** recherche de tout le vocabulaire d'exclusion
du module (`exclud`, `libraryMuIds`, `NOT IN`, `Not(In(`) **et** de tous les usages du
repository `UserManga` hors specs, puis vérification que chaque site retenu part bien du
set unique. Deux garde-fous rendent l'oubli détectable plutôt que silencieux :
- `GenreSectionService.buildSections` prend le set en paramètre **obligatoire** —
  l'omettre est une erreur de compilation, pas une régression muette ;
- un test par chemin (cf. tableau des tests) casse la CI si une branche cesse de filtrer.

### Défense en profondeur

Trois filtres redondants sont conservés volontairement, car ils protègent des chemins
dont la garantie amont pourrait changer : `augmentWithCatalog` refiltre les candidats
qu'il ajoute, `GenreSectionService` ignore une entrée exclue présente dans le pool, et
`getRecommendationsAsQuickView` filtre après le merge des recos communautaires.

### Invalidation du cache

`RecoCacheService.invalidateUser(userId)` est appelé au rejet **et** à l'annulation.
Sans ça, l'effet ne serait visible qu'à l'expiration du TTL d'une heure — l'utilisateur
écarterait un titre, rechargerait, et le reverrait.

### Ce que le rejet n'est pas

Ce n'est pas un masquage global : un titre écarté reste cherchable, ouvrable et
ajoutable en bibliothèque. Seules les **recommandations** le filtrent.

---

## Stratégie cache et fetch MU

Le module ne gère pas lui-même le cache des recommandations MU — il délègue entièrement à `MangasService` :

- `getCachedRecommendations(muId)` → retourne les `MangaRecommendation[]` en cache (ou `[]`).
- `fetchAndCacheRecommendations(muId)` → appelle l'API MangaUpdates, écrit en base, retourne le résultat. Lève `MuRateLimitException` sur HTTP 429 (interceptée et traduite en `[]` par `MangasService.getRecommendationsForManga`).

**Logique de branchement** :
1. Si au moins un manga source a un cache non vide → réponse rapide avec le cache disponible. Les non-cachés sont traités en fire-and-forget (`fetchUncachedInBackground`).
2. Si aucun manga source n'a de cache → `fetchAndScoreBlocking` (batches de 5, timeout 15 s, délai 1 s inter-batch, pause 5 s sur 429).
3. Dans les deux cas, si `scoreMap.size < CATALOG_MIN_POOL` (150) → `augmentWithCatalog` complète le pool depuis le catalogue local.

Un cache in-memory user-level (TTL 1h) est géré par `RecoCacheService` — invalidé sur toute mutation de la bibliothèque.

### Hydratation à la demande des cartes incomplètes (fix 2026-08-28)

**Problème** : les stubs créés par `saveRecommendations` n'ont ni `year` ni `rating` (l'endpoint MU « recommendations » ne les renvoie pas). Les DTO exposent alors le repli `0`, que l'app traduit en « donnée absente » — la carte s'affiche avec son image mais sans année ni étoiles. Le job nightly seul mettait plusieurs nuits à rattraper le stock.

**Mécanisme** : `RecommendationService.buildDtoFromScoreMap` et `GenreSectionService.buildSections` repèrent les DTO renvoyés avec `year == 0 || rating == 0` et déclenchent `MangasService.getMangaDetails` dessus via `hydrateIncompleteDtosInBackground` (`manga-completeness.util.ts`). Calqué sur le background refresh des covers de `getRecommendationsAsQuickView`.

| Garantie | Détail |
|----------|--------|
| **Plafond** | `ON_DEMAND_HYDRATION_CAP` = 8 mangas par requête, dédupliqués (toutes sections confondues pour by-genre) |
| **Non bloquant** | Fire-and-forget strict : aucun `await`, la requête principale répond avec les données actuelles |
| **Non fatal** | Aucune exception ne remonte ; un 429 `MuRateLimitException` est loggé puis avalé |

⚠️ **Visibilité** : `RecoCacheService` (TTL 1 h) sert les réponses en cache. L'amélioration n'est donc perceptible qu'au **prochain miss de cache** de l'utilisateur, pas sur la requête qui a déclenché l'hydratation. Résultat visible sous 24 h au lieu de plusieurs nuits.

Le filet de sécurité reste le job nightly `hydration` (`CatalogSyncService.hydrateIncompleteRows`, voir `docs/specs/mangas/spec-technique.md`), qui priorise justement les `mu_id` présents dans `manga_recommendation`.

---

## Patterns identifiés

- **Service layer pur** : le controller ne contient aucune logique. Il délègue intégralement au service.
- **Accumulation de scoreMap** : pattern de scoring par contribution additive depuis plusieurs sources hétérogènes, analogue à un moteur de recommandation collaboratif simplifié basé sur les signaux explicites de l'utilisateur.
- **Stratégie cache-first avec background refresh** : inspiré du stale-while-revalidate. Priorise la latence sur la fraîcheur.
- **Cold start explicite** : branche distincte dans le code quand `userMangas.length === 0`, évite de retourner une liste vide pour un premier usage.
- **Dénormalisation partielle** : `recommended_title` dupliqué dans `manga_recommendation` pour éviter un JOIN systématique (voir entité).

---

## Décisions documentées ici (rejetées comme ADR)

### Cap MAX_RECOS_PER_SOURCE = 40 (évolutions 2026-05-19 + hotfix-v0-10-1)

Passage 10 → 30 (2026-05-19) puis 30 → 40 (hotfix-v0-10-1). Motivation : le taux d'exclusion biblio vidait le pool. Impact local au service, pas transverse.
Rejeté comme ADR : AP-3 (heuristique d'implémentation) + Q3=NON (mono-module).

### Suppression de `relaxIfPoolTooSmall` — remplacé par `augmentWithCatalog`

`relaxIfPoolTooSmall` élargissait le cap `MAX_RECOS_PER_SOURCE` en rejouant le scoring sur les recos `[40..80[` du cache. No-op prouvé : les tableaux de recos MU cachés font ~5-25 entrées, donc `slice(40,80)` retournait toujours un tableau vide.

Remplacé par `augmentWithCatalog` qui interroge la table `manga` locale (catalogue nightly ~5000 titres), avec un vrai score par affinité de genres. Seuil `CATALOG_MIN_POOL=150` (vs l'ancien `MIN_POOL_BEFORE_RELAX=50`).

Impact confiné au service. Rejeté comme ADR : Q3=NON (mono-module).

### CATALOG_MIN_POOL = 150

Valeur empirique pour déclencher le top-up catalogue avant qu'une pagination `limit=50, offset=0` ne tombe dans un pool insuffisant.
Rejeté comme ADR : AP-3 (heuristique d'implémentation) + Q3=NON.

### Genres NSFW hardcodés dans le service

Historique : liste inline `['Adult', 'Mature', 'Hentai', 'Smut', 'Yaoi', 'Yuri', 'Ecchi']` dans `buildUserRecommendationsByGenre`. Depuis le fix 2026-08-25, `GenreSectionService.EXCLUDED_SECTION_GENRES` = union de `NSFW_GENRES` (constants, utilisée par les requêtes catalogue) et de l'ancienne liste inline — couverture la plus large des deux, toujours pas de table/enum centralisé.  
Rejeté comme ADR : AP-3 (heuristique de configuration) + Q3=NON.

### userId sentinelle -1 pour cold start sleepers — **abandonné (2026-08-28)**

`buildColdStartRecommendations` appelait `findSleeperHits(-1, ...)` pour signaler
« pas de bibliothèque à exclure ». La feature « pas intéressé / déjà vu » a invalidé
ce raccourci : **bibliothèque vide ne veut pas dire rien à exclure** — un compte sans
aucun titre peut très bien avoir déjà écarté One Piece, c'est même le cas d'usage
fondateur. Le cold start reçoit et propage désormais le vrai `userId`.

La sentinelle survit uniquement comme garde défensive dans
`DismissalService.getDismissedMuIds` (`userId <= 0` → set vide sans requête).
Rejeté comme ADR : AP-4 (workaround local).

### `recommended_title` dénormalisé dans `manga_recommendation`

Champ de confort pour éviter un JOIN. Décision de schéma non architecturale, impact single-table.  
Rejeté comme ADR : AP-7 (détail de schéma non-architectural).

---

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|---------------|--------|
| `src/api/recommendations/recommendation.service.spec.ts` | Cold start (vide + top communauté), exclusion biblio, cap MAX_RECOS_PER_SOURCE, tri par score, multiplicateur statut, recommendedBecauseOf, fetch bloquant, résilience timeout, filtre genre, segmentation by-genre (exclusivité), filtre NSFW, sleeper hits (exclusion, visibilité, tri, covers), complément catalogue | Existant |
| `src/api/recommendations/genre-section.service.spec.ts` | Fix by-genre 2026-08-25 : dédup par mu_id (genres dupliqués), exclusivité inter-sections, bascule vers le genre suivant si section pleine, complément catalogue (exclusions, rating floor, NSFW, limit, 1 requête/section), classement genres biblio + fallback pool, panne catalogue, sections vides omises, contrat DTO | Existant |
| `src/api/recommendations/catalog-candidate.service.spec.ts` | Candidats catalogue liste plate (genres favoris, score, exclusions) | Existant |
| `src/api/recommendations/dismissal.service.spec.ts` | Rejets : unicité par upsert `ON CONFLICT`, annulation + 404 sur double annulation, invalidation du cache de recos, sentinelle `userId <= 0` sans requête, union biblio ∪ rejets, listing trié | Ajouté 2026-08-28 |
| Tests d'exclusion (répartis) | Un test par chemin de reco dans `recommendation.service.spec.ts` (liste plate, catalogue, by-genre, sleepers, cold start ×2), `genre-section.service.spec.ts` (complément catalogue + défense en profondeur) et `mangas.service.spec.ts` (fiche détail ×3) | Ajouté 2026-08-28 |
| Tests controller | Non présents dans le module | Absent |
