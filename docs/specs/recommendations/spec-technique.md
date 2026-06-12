# Spec Technique — Recommendations

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | recommendations     |
| Version       | 0.1.0               |
| Date          | 2026-06-04          |
| Source        | Rétro-ingénierie    |

---

## Architecture du module

Le module est composé d'un controller NestJS pur (HTTP routing) et d'un service unique portant l'intégralité de la logique de scoring. Aucune couche repository dédiée : les accès BDD passent directement par les repositories TypeORM injectés.

```
RecommendationController
  └─ RecommendationService
       ├─ buildUserRecommendations()        ← endpoint principal, paginé
       ├─ buildUserRecommendationsByGenre() ← home segmentée
       ├─ findSleeperHits()                 ← pépites récentes
       ├─ buildColdStartRecommendations()   ← fallback biblio vide
       ├─ buildTopCommunityDtos()           ← top notes locales
       ├─ computeScoreMap()                 ← calcul factoriel interne (partagé)
       ├─ scoreRecos()                      ← accumulation du scoreMap
       ├─ relaxIfPoolTooSmall()             ← cap adaptatif
       ├─ computeMultiplier()               ← statut × récence × note
       ├─ buildDtoFromScoreMap()            ← assemblage final + enrichissement
       └─ fetchUncachedInBackground()       ← fire-and-forget fetch MU
```

**Dépendances injectées :**
- `Repository<UserManga>` — bibliothèque de l'utilisateur
- `Repository<MangaRecommendation>` — pool de recommandations MU
- `Repository<Manga>` — métadonnées mangas (genres, covers, year, rating)
- `MangasService` — cache/fetch MU + note agrégée bayésienne

---

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/recommendations/recommendation.service.ts` | Logique de scoring, cold start, sleepers | ~926 |
| `src/api/recommendations/recommendation.controller.ts` | Routes HTTP, parsing query params | ~128 |
| `src/api/recommendations/recommendation.module.ts` | Déclaration NestJS, imports TypeORM | ~19 |
| `src/api/recommendations/recommendation.service.spec.ts` | Tests unitaires Jest | ~702 |
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

Liste inline : `['Adult', 'Mature', 'Hentai', 'Smut', 'Yaoi', 'Yuri', 'Ecchi']`. Pas de table ou enum centralisé. Impact confiné à `buildUserRecommendationsByGenre`.  
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
| `src/api/recommendations/recommendation.service.spec.ts` | Cold start (vide + top communauté), exclusion biblio, cap MAX_RECOS_PER_SOURCE, tri par score, multiplicateur statut, recommendedBecauseOf, fetch bloquant, résilience timeout, filtre genre, segmentation by-genre, filtre NSFW, sleeper hits (exclusion, visibilité, tri, covers) | Existant |
| Tests controller | Non présents dans le module | Absent |
