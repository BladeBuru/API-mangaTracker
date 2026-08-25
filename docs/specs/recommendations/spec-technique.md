# Spec Technique — Recommendations

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | recommendations     |
| Version       | 0.1.0               |
| Date          | 2026-06-04          |
| Source        | Rétro-ingénierie    |

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

**Note** : le Swagger documente `max: 100` sur `limit` mais le code applique `MAX_LIMIT = 500`. Incohérence à corriger.

---

## Constantes de configuration

| Constante | Valeur | Rôle |
|-----------|--------|------|
| `STATUS_MULTIPLIER` | `{ completed: 1.5, caughtUp: 1.3, reading: 1.2, readLater: 0.8 }` | Poids selon statut de lecture |
| `RECENCY_HALF_LIFE_DAYS` | 365 | Demi-vie de pertinence en jours |
| `MAX_RECOS_PER_SOURCE` | 30 | Cap normal de recos par manga source |
| `ADAPTIVE_FALLBACK_CAP` | 60 | Cap relaxé si pool < MIN_POOL |
| `MIN_POOL_BEFORE_RELAX` | 50 | Seuil de déclenchement du cap adaptatif |
| `MAX_LIMIT` | 500 | Limite max pagination |
| `COLD_START_MIN_VOTES` | 5 | Votes locaux min pour le top communauté |
| `COLD_START_SLEEPER_BUDGET` | 30 | Sleepers max en cold start |
| `BATCH_SIZE` | 5 | Taille des batchs de fetch MU bloquant |
| `FETCH_TIMEOUT_MS` | 15 000 | Timeout par fetch MU (ms) |

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

Pour chaque `MangaRecommendation` issue du manga source (triées par `weight` desc, tronquées au cap) :

```
if (recommended_mu_id IN libraryMuIds) → skip
contribution = reco.weight × multiplier
scoreMap[recommended_mu_id].score += contribution
scoreMap[recommended_mu_id].sources[sourceMuId] += contribution
```

### Cap adaptatif (`relaxIfPoolTooSmall`)

Si `scoreMap.size < 50` après la première passe :
- Pour chaque manga source, reprendre les recos en cache indexées de `[30..60[` (sans re-sommer les premières 30 déjà comptabilisées).
- Appliquer `scoreRecos` sur cette queue supplémentaire.

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

## Stratégie cache et fetch MU

Le module ne gère pas lui-même le cache — il délègue entièrement à `MangasService` :

- `getCachedRecommendations(muId)` → retourne les `MangaRecommendation[]` en cache (ou `[]`).
- `fetchAndCacheRecommendations(muId)` → appelle l'API MangaUpdates, écrit en base, retourne le résultat.

**Logique de branchement** :
1. Si au moins un manga source a un cache non vide → réponse rapide avec le cache disponible. Les non-cachés sont traités en fire-and-forget.
2. Si aucun manga source n'a de cache → fetch bloquant batché (BATCH_SIZE=5, timeout=15s par requête). Erreur → warn + résultat partiel.

---

## Patterns identifiés

- **Service layer pur** : le controller ne contient aucune logique. Il délègue intégralement au service.
- **Accumulation de scoreMap** : pattern de scoring par contribution additive depuis plusieurs sources hétérogènes, analogue à un moteur de recommandation collaboratif simplifié basé sur les signaux explicites de l'utilisateur.
- **Stratégie cache-first avec background refresh** : inspiré du stale-while-revalidate. Priorise la latence sur la fraîcheur.
- **Cold start explicite** : branche distincte dans le code quand `userMangas.length === 0`, évite de retourner une liste vide pour un premier usage.
- **Dénormalisation partielle** : `recommended_title` dupliqué dans `manga_recommendation` pour éviter un JOIN systématique (voir entité).

---

## Décisions documentées ici (rejetées comme ADR)

### Cap MAX_RECOS_PER_SOURCE = 30 (évolution du 2026-05-19)

Décision de configuration : passage de 10 à 30. Motivation : le taux d'exclusion biblio vidait le pool. Impact local au service, pas transverse. Documenté dans le commentaire JSDoc de la constante.  
Rejeté comme ADR : AP-3 (heuristique d'implémentation) + Q3=NON (mono-module).

### Genres NSFW hardcodés dans le service

Historique : liste inline `['Adult', 'Mature', 'Hentai', 'Smut', 'Yaoi', 'Yuri', 'Ecchi']` dans `buildUserRecommendationsByGenre`. Depuis le fix 2026-08-25, `GenreSectionService.EXCLUDED_SECTION_GENRES` = union de `NSFW_GENRES` (constants, utilisée par les requêtes catalogue) et de l'ancienne liste inline — couverture la plus large des deux, toujours pas de table/enum centralisé.  
Rejeté comme ADR : AP-3 (heuristique de configuration) + Q3=NON.

### userId sentinelle -1 pour cold start sleepers

`findSleeperHits(-1, ...)` utilisé depuis `buildColdStartRecommendations` pour signaler qu'il n'y a pas de bibliothèque à exclure. Workaround local, pas d'invariant architectural.  
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
| Tests controller | Non présents dans le module | Absent |
