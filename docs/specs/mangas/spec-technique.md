# Spec Technique — Mangas

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | mangas              |
| Version       | 0.1.0               |
| Date          | 2026-06-04          |
| Source        | Rétro-ingénierie    |

---

## Architecture du module

Le module `mangas` regroupe deux controllers, cinq services, deux entités et plusieurs DTOs. Il est découpé selon les responsabilités suivantes :

- **MangasController** : endpoints catalogue (tendances, recherche, détail, recommandations)
- **MangaCoversController** : endpoints covers (proxy redirect, refresh, sync admin)
- **MangasService** : logique métier centrale (fetch MU, cache BDD, recommandations, notes communautaires)
- **UpdateMangaService** : détection et rafraîchissement batch des données périmées
- **MangaSyncService** : synchronisation complète de toute la table `manga`
- **CoverProxyService** : résolution de l'URL upstream pour le proxy 302
- **HelperService** : utilitaires de formatage des requêtes MU

La dépendance circulaire avec `LibraryModule` est gérée via `forwardRef()` dans `MangasModule`.

---

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/mangas/mangas.controller.ts` | Controller catalogue (tendances, recherche, détail, recommandations) | ~195 |
| `src/api/mangas/manga-covers.controller.ts` | Controller covers (proxy, refresh, sync admin) | ~95 |
| `src/api/mangas/mangas.service.ts` | Service principal — fetch MU, cache, community ratings, recos | ~573 |
| `src/api/mangas/update-manga.service.ts` | Détection outdated + refresh batch avec rate-limiting | ~205 |
| `src/api/mangas/sync-manga.service.ts` | Sync séquentielle complète de la table manga | ~50 |
| `src/api/mangas/cover-proxy.service.ts` | Résolution URL upstream + fallback live MU | ~145 |
| `src/api/mangas/rating-aggregator.ts` | Formule Bayesienne pure (fonction standalone) | ~76 |
| `src/api/mangas/manga.entity.ts` | Entité TypeORM `manga` avec factory `fromMU` | ~113 |
| `src/api/mangas/manga-recommendation.entity.ts` | Entité TypeORM `manga_recommendation` | ~33 |
| `src/api/mangas/dto/manga-details.dto.ts` | DTO détail manga — parsing MU + enrichissement user | ~399 |
| `src/api/mangas/dto/manga-quick-view.dto.ts` | DTO liste manga — factories fromMu/fromLibrary | ~130 |
| `src/api/mangas/dto/search-manga.dto.ts` | DTO corps de requête recherche | ~(petit) |
| `src/api/mangas/constants.ts` | URLs MU et liste NSFW_GENRES | ~17 |
| `src/api/mangas/mangas.module.ts` | Déclaration du module NestJS | ~35 |
| `src/api/mangas/helper.service.ts` | Formatage des requêtes vers l'API MU | ~(petit) |

---

## Schéma BDD

### Table `manga`

| Colonne | Type | Contrainte | Notes |
|---------|------|-----------|-------|
| `id` | integer | PK, auto-increment | Clé interne |
| `mu_id` | bigint | UNIQUE NOT NULL | Identifiant MangaUpdates |
| `title` | varchar | NOT NULL | Toujours renseigné, y compris pour les stubs |
| `small_cover_url` | varchar | nullable | URL thumb CDN MU — peut être NULL sur un stub |
| `medium_cover_url` | varchar | nullable | URL original CDN MU — toujours préféré pour l'affichage |
| `total_chapters` | integer | DEFAULT 0 | Valeur la plus élevée conservée lors des syncs |
| `rating` | decimal(3,2) | nullable | Bayesian rating MU (sur 10) |
| `year` | integer | nullable | Année de publication |
| `completed` | boolean | nullable | Statut de complétion selon MU |
| `associated` | json | nullable | Titres alternatifs `[{title: string}]` |
| `genres` | json | nullable | Genres normalisés `string[]` |
| `created_at` | timestamp | auto | |
| `updated_at` | timestamp | auto | Utilisé pour détecter les données périmées (> 1 jour) |

**Relation** : `manga` → `user_manga` (OneToMany via `UserManga.manga`)

### Table `manga_recommendation`

| Colonne | Type | Contrainte | Notes |
|---------|------|-----------|-------|
| `id` | integer | PK, auto-increment | |
| `source_mu_id` | bigint | NOT NULL | mu_id du manga source |
| `recommended_mu_id` | bigint | NOT NULL | mu_id du manga recommandé |
| `recommended_title` | varchar | nullable | Dénormalisé pour éviter les JOINs |
| `weight` | integer | NOT NULL | Poids MU (échelle 1-100) |
| `updated_at` | timestamp | auto | Utilisé pour l'expiration du cache (> 7 jours) |

**Index unique** : `(source_mu_id, recommended_mu_id)`

**Stratégie upsert** : `orUpdate(['weight', 'recommended_title', 'updated_at'], ['source_mu_id', 'recommended_mu_id'])` — le poids et le titre sont mis à jour si la paire existe déjà.

---

## API / Endpoints

### MangasController (`/mangas`)

| Méthode | Route | Description | Auth |
|---------|-------|-------------|------|
| GET | `/mangas/popular` | Tendances par rating MU | JWT |
| GET | `/mangas/new` | Nouveautés par année | JWT |
| GET | `/mangas/trending` | Tendances hebdomadaires (week_pos) | JWT |
| GET | `/mangas/recommendations/:muId` | Recommandations fusionnées MU + communauté | JWT |
| GET | `/mangas/:id` | Fiche détail enrichie (library + community rating) | JWT |
| POST | `/mangas/search` | Recherche textuelle (body SearchMangaDto) | JWT |

### MangaCoversController (`/mangas`)

| Méthode | Route | Description | Auth | Throttle |
|---------|-------|-------------|------|---------|
| GET | `/mangas/:muId/cover` | Proxy 302 vers CDN MU | Public | Global |
| POST | `/mangas/:muId/refresh-cover` | Force refresh covers depuis MU | JWT | 10/min |
| POST | `/mangas/admin/sync-all` | Sync complète table manga | Secret query param | Aucun |

**Note** : `/mangas/:muId/cover` retourne `Cache-Control: public, max-age=300` (5 minutes).

---

## Patterns identifiés

### Pattern stub-then-fill

L'entité `Manga` a deux états de vie :
1. **Stub** : inséré via `saveRecommendations` avec uniquement `mu_id` + `title` (et éventuellement les covers si fournies par MU dans `series_image`). Tous les autres champs sont NULL. Insertion via `ON CONFLICT DO NOTHING`.
2. **Complet** : rempli par `getMangaDetails` qui appelle MU, mappe via `MangaDetailsDto.fromMU`, et fait un `UPDATE` en BDD.

Les deux états coexistent. Le code downstream doit tolérer les champs nullable.

### Pattern fire-and-forget avec rate-limiting

Les mises à jour en arrière-plan (recommandations, refresh covers stubs, refresh batch outdated) utilisent le pattern fire-and-forget (`Promise.allSettled(...).catch(() => undefined)` ou `.catch(err => logger.warn(...))`). Le batch de refresh (UpdateMangaService) est séquentiel par groupes de 5 avec pause de 1 000 ms entre batches pour rester sous le rate-limit MU.

### Pattern proxy 302 (pas de proxy fetch server-side)

`CoverProxyService` résout uniquement une URL, le controller fait la redirection. Le service ne fetch jamais l'image côté Node. Trois niveaux de fallback :
1. URL en cache BDD → redirect direct
2. Cache BDD absent ou URL NULL → `UpdateMangaService.refreshCovers` → re-read BDD → redirect
3. Manga absent de BDD → fetch live MU detail (timeout 5s, sans persistance) → redirect

La méthode `pickUrl` ignore volontairement le paramètre `size` et retourne toujours `medium_cover_url ?? small_cover_url` — les URLs `/thumb/` de MU retournent 404 systématiquement pour les mangas indexés via API.

### Formule Bayesienne (rating-aggregator.ts)

Formule implémentée :

```
aggregated = (C × MU_rating + n × community_avg) / (C + n)
```

Avec `C = 50` (RATING_CONFIDENCE_WEIGHT). Comportements aux limites :
- `n = 0` → `aggregated = MU_rating`
- `MU_rating = 0` → `aggregated = community_avg` (fallback pur local)
- `n >> C` → `aggregated ≈ community_avg`

Le calcul est effectué par `getCommunityRatings` (MangasService) qui fait une requête SQL `GROUP BY manga_id` sur `user_manga` pour obtenir moyenne et count des `user_rating > 0`, puis appelle `aggregateRating` par manga.

### Recherche avec scoring de pertinence

La recherche soumet `limit * 3` résultats à MU (filtré par rating décroissant), puis re-trie selon un système de bonus :

| Condition | Bonus |
|-----------|-------|
| Titre = query exacte | 100 000 |
| Titre commence par `"<query> "` ou `"<query>:"` | 50 000 |
| Titre commence par query | 30 000 |
| Query est un mot du titre | 10 000 |
| Query apparaît dans le titre | 5 000 |
| Alias exact | 8 000 |
| Alias commence par query | 3 000 |
| Alias contient query | 1 000 |

Le bonus est additionné au `bayesian_rating` (max 10) pour le tri final.

### Recommandations communautaires (co-occurrence)

`findCommunityRecommendations` utilise un self-join sur `user_manga` :
- `um1` : lignes où l'utilisateur a le manga source
- `um2` : autres mangas des mêmes utilisateurs
- Count distinct par `manga_id` → « N utilisateurs ont aussi ce manga »

Pas de `user_id` exposé dans la réponse (conformité RGPD documentée dans le code).

---

## Décisions techniques documentées en spec (candidats ADR rejetés)

### Proxy 302 redirect vs proxy fetch server-side

Décision : utiliser un redirect HTTP 302 plutôt que de fetcher l'image côté Node et la relayer. Raison : le CDN MU peut bloquer le serveur API (User-Agent, IP, géolocalisation) mais ne bloque pas les navigateurs clients. Avantages supplémentaires : cache navigateur natif, moins de bande passante serveur. Implémenté dans `CoverProxyService` et `MangaCoversController`.

Cette décision relève d'un workaround face à une contrainte externe (CDN MU) — elle est confinée au module covers et ne contraint pas d'autres modules. Documentée ici plutôt qu'en ADR (Q3=NON, Q4=NON).

### Exclusion NSFW par liste hardcodée (NSFW_GENRES)

La liste `['Adult', 'Smut', 'Hentai', 'Lolicon', 'Shotacon', 'Doujinshi']` dans `constants.ts` est transmise telle quelle à MU via le paramètre `exclude_genre`. L'exclusion se fait uniquement côté MU, pas localement sur les résultats retournés. Cela signifie qu'un manga avec ces genres qui serait déjà en BDD locale n'est pas filtré sur les endpoints de détail ou de bibliothèque. Documenté ici (décision confinée au module, modifiable en 5 min) plutôt qu'en ADR.

### Poids de confiance Bayesian C=50

La constante `RATING_CONFIDENCE_WEIGHT = 50` signifie qu'il faut 50 votes locaux pour que la communauté locale pèse autant que la note MU. Cette valeur est hardcodée et non configurable via env. Choix empirique, documenté dans le commentaire JSDoc de `rating-aggregator.ts`.

### Sync admin protégée par DATABASE_PASSWORD

`POST /mangas/admin/sync-all?secret=<DATABASE_PASSWORD>` n'utilise pas de JWT mais compare le paramètre à `DATABASE_PASSWORD`. Ce pattern est inhabituel (le mot de passe DB comme shared secret admin) et constitue potentiellement une dette de sécurité. Zone d'incertitude : intention délibérée ou workaround temporaire ?

---

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|---------------|--------|
| `src/api/mangas/mangas.service.spec.ts` | Tests unitaires MangasService | Existant |
| `src/api/mangas/rating-aggregator.spec.ts` | Tests unitaires formule Bayesienne (comportements aux limites) | Existant |
