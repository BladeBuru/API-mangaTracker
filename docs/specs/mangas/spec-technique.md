# Spec Technique — Mangas

| Champ         | Valeur                                                                      |
|---------------|-----------------------------------------------------------------------------|
| Module        | mangas                                                                      |
| Version       | 0.2.0                                                                       |
| Date          | 2026-08-26                                                                  |
| Source        | Rétro-ingénierie + feat/recos-chapitres-traductions + fix/recos-by-genre-dedup (corrections revue adversariale) |

---

## Architecture du module

Le module `mangas` regroupe deux controllers, sept services, quatre entités et plusieurs DTOs. Il est découpé selon les responsabilités suivantes :

- **MangasController** : endpoints catalogue (tendances, recherche, détail, recommandations)
- **MangaCoversController** : endpoints covers (proxy redirect, refresh, sync admin)
- **MangasService** : logique métier centrale (fetch MU, cache BDD, recommandations, notes communautaires)
- **UpdateMangaService** : détection et rafraîchissement batch des données périmées
- **MangaSyncService** : synchronisation complète de toute la table `manga`
- **CoverProxyService** : résolution de l'URL upstream pour le proxy 302
- **HelperService** : utilitaires de formatage des requêtes MU
- **DescriptionTranslationService** : cache Postgres des descriptions traduites + cascade providers (DeepL / gtx) + dédup in-flight + SWR sur hash mismatch + negative-cache 5 min
- **CatalogSyncService** : synchronisation nightly paginée du catalogue MU vers la table `manga` (cron 03:30, curseur de reprise, backoff 429, statut `partial` sur erreur DB + `consecutive_failures++`)

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
| `src/api/mangas/manga-translation.entity.ts` | Entité TypeORM `manga_translation` (cache traductions) | ~48 |
| `src/api/mangas/catalog-sync-state.entity.ts` | Entité TypeORM `catalog_sync_state` (curseur de reprise cron) | ~66 |
| `src/api/mangas/catalog-sync.service.ts` | Sync nightly catalogue MU — cron, pagination, backoff, curseur, statut partial sur erreur DB | ~380 |
| `src/api/mangas/catalog-sync.mapper.ts` | Mapping records MU → lots upsert `manga` (lots séparés genre/non-genre, rating/year/covers null-safe) | ~82 |
| `src/api/mangas/genre.utils.ts` | Normalisation des formats genres MU hétérogènes (`string` / `{genre}`) | ~24 |
| `src/api/mangas/exceptions/mu-rate-limit.exception.ts` | Exception typée HTTP 429 MU — distingue rate-limit d'un échec quelconque | ~18 |
| `src/api/mangas/translation/translation-provider.interface.ts` | Interface commune des providers de traduction | ~27 |
| `src/api/mangas/translation/deepl.provider.ts` | Provider DeepL API Free (actif si `DEEPL_API_KEY` configuré) | ~83 |
| `src/api/mangas/translation/gtx.provider.ts` | Provider Google gtx fallback (sans clé, toujours disponible) | ~120 |
| `src/api/mangas/translation/description-translation.service.ts` | Orchestration cache + SWR hash mismatch + negative-cache 5 min + cascade providers + dédup in-flight + timeout | ~217 |
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

### Table `manga_translation`

| Colonne | Type | Contrainte | Notes |
|---------|------|-----------|-------|
| `id` | integer | PK, auto-increment | |
| `mu_id` | bigint | NOT NULL | ID MU du manga |
| `language` | varchar(5) | NOT NULL | Code primaire 2 lettres : `fr`, `de`, `es`, `pt`, `ja`, `ko` |
| `source_hash` | varchar(64) | NOT NULL | sha256 hex de la description source — pilote l'invalidation |
| `translated_description` | text | NOT NULL | Description traduite |
| `updated_at` | timestamp | auto-updated | |

**Index unique** : `(mu_id, language)`. **Migration** : `1753200000000-CreateMangaTranslationTable`.

**Invariant SWR** : en cas de hash mismatch (description MU modifiée), la ligne existante est renvoyée immédiatement (stale) pendant que la retraduction s'exécute en arrière-plan et met à jour le cache. Un negative-cache 5 min est maintenu en mémoire pour les langues dont la traduction a échoué, afin d'éviter de re-solliciter les providers sur chaque requête.

### Table `catalog_sync_state`

| Colonne | Type | Contrainte | Notes |
|---------|------|-----------|-------|
| `id` | integer | PK, auto-increment | |
| `job_name` | varchar | UNIQUE NOT NULL | `catalog:rating`, `catalog:week_pos`, `hydration` |
| `last_completed_page` | integer | DEFAULT 0 | Curseur de reprise |
| `total_pages` | integer | nullable | Connu après la 1re réponse MU |
| `last_run_at` | timestamptz | nullable | Date du dernier run |
| `last_run_status` | varchar | nullable | `completed`, `partial`, `failed` |
| `consecutive_failures` | integer | DEFAULT 0 | Remis à 0 sur passe complétée ; incrémenté sur erreur DB (sans sauter la passe) |
| `created_at` | timestamp | auto | |
| `updated_at` | timestamp | auto | |

**3 lignes max** (une par `job_name`). **Migration** : `1753300000000-CreateCatalogSyncState`.

---

## API / Endpoints

### MangasController (`/mangas`)

| Méthode | Route | Description | Auth |
|---------|-------|-------------|------|
| GET | `/mangas/popular` | Tendances par rating MU | JWT |
| GET | `/mangas/new` | Nouveautés par année | JWT |
| GET | `/mangas/trending` | Tendances hebdomadaires (week_pos) | JWT |
| GET | `/mangas/recommendations/:muId` | Recommandations fusionnées MU + communauté | JWT |
| GET | `/mangas/:id` | Fiche détail enrichie (library + community rating + traduction optionnelle) | JWT |
| POST | `/mangas/search` | Recherche textuelle (body SearchMangaDto) | JWT |

**`GET /mangas/:id` — comportement traduction** : lit le header `Accept-Language`. Si la langue primaire est supportée (`fr`, `de`, `es`, `pt`, `ja`, `ko`), la réponse inclut `translated_description` (string). Si la langue est `en` ou absente, le champ est omis. La traduction ne bloque jamais : timeout dépassé ou échec → champ absent, réponse 200 renvoyée normalement. Hash mismatch → stale renvoyé, retraduction en background (SWR).

### MangaCoversController (`/mangas`)

| Méthode | Route | Description | Auth | Throttle |
|---------|-------|-------------|------|---------|
| GET | `/mangas/:muId/cover` | Proxy 302 vers CDN MU | Public | Global |
| POST | `/mangas/:muId/refresh-cover` | Force refresh covers depuis MU | JWT | 10/min |
| POST | `/mangas/admin/sync-all` | Sync complète table manga | Secret query param | Aucun |

**Note** : `/mangas/:muId/cover` retourne `Cache-Control: public, max-age=300` (5 minutes).

---

## Variables d'environnement (feat/recos-chapitres-traductions)

| Variable | Défaut | Description |
|----------|--------|-------------|
| `DEEPL_API_KEY` | _(absent)_ | Clé API DeepL Free — si absent, fallback automatique sur Google gtx |
| `TRANSLATION_TIMEOUT_MS` | `4000` | Timeout dur (ms) de la traduction synchrone au 1er visiteur |
| `CATALOG_SYNC_ENABLED` | `true` (`false` si `NODE_ENV=test`) | Active/désactive le cron catalogue |
| `CATALOG_SYNC_MAX_PAGES` | `50` | Pages max de la passe `catalog:rating` (100 titres/page ≈ 5000 titres) |
| `CATALOG_SYNC_PAGES_PER_RUN` | `60` | Budget de pages par nuit (toutes passes confondues) |
| `CATALOG_SYNC_DELAY_MS` | `2000` | Délai entre 2 appels MU (30 req/min = 50 % du plafond MU anonyme) |
| `CATALOG_SYNC_HYDRATION_BUDGET` | `200` | Appels `getMangaDetails` max/nuit pour hydrater les `genres IS NULL` |

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

### Pattern traduction côté serveur (DescriptionTranslationService)

Stratégie à 5 couches :
1. **Cache Postgres `manga_translation`** clé `(mu_id, language)`. Hit avec hash identique → zéro appel externe.
2. **Stale-While-Revalidate sur hash mismatch** : si `source_hash` diffère (description MU mise à jour), la traduction existante est retournée immédiatement (`stale`) pendant qu'une retraduction s'exécute en arrière-plan et met à jour le cache (correction adversariale d8641f4).
3. **Negative-cache 5 min** en mémoire : les langues dont la traduction a échoué (quota, réseau) sont ignorées pendant 5 min, évitant de spammer les providers sur chaque requête (correction adversariale d8641f4).
4. **Cascade providers** : DeepL (si `DEEPL_API_KEY`) puis Google gtx fallback. Le premier résultat non-null gagne.
5. **Timeout dur** `TRANSLATION_TIMEOUT_MS` (4 s) + **dédup in-flight** : une seule promesse en vol par clé `"<muId>:<lang>"`.

Invariant : une traduction ratée ne produit jamais de 5xx.

### Pattern catalogue nightly avec curseur de reprise (CatalogSyncService)

Cron `03:30` + jitter aléatoire 0-15 min. Politique réseau : 1 appel / `CATALOG_SYNC_DELAY_MS` (2 s). Backoff 5/10/20/40 s sur 429/5xx (4 retries).

Trois jobs (`catalog:rating`, `catalog:week_pos`, `hydration`), 1 ligne `catalog_sync_state` par job. Reprise automatique via `last_completed_page`. Sur erreur DB dans `runCatalogPass` : statut `partial` écrit + `consecutive_failures` incrémenté, la passe ne saute pas (correction adversariale d8641f4) — l'ancien comportement loggait l'erreur mais poursuivait sans mettre à jour l'état.

**Stratégie upsert catalogue** (`catalog-sync.mapper.ts`) : lots séparés pour les records avec/sans genres — le lot sans genres n'inclut pas `genres` dans `orUpdate` (les genres existants ne sont jamais écrasés par null). Les colonnes `rating`, `year`, `small_cover_url`, `medium_cover_url` ne sont jamais écrasées par null : seules les valeurs non-null du record MU sont incluses dans `orUpdate` (correction adversariale d8641f4).

### Dégradation gracieuse sur rate-limit MU (MangasService)

`getRecommendationsForManga` intercepte `MuRateLimitException` (429 MU) et retourne `[]` au lieu de propager l'exception (correction adversariale d8641f4). L'appelant (`RecommendationService`) reçoit un tableau vide et continue — plus de 429 propagé au client.

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
| `src/api/mangas/catalog-sync.service.spec.ts` | Tests unitaires CatalogSyncService (cron, backoff, curseur, statut partial) | À créer |
| `src/api/mangas/translation/description-translation.service.spec.ts` | Tests unitaires DescriptionTranslationService (cache hit, SWR, negative-cache, cascade providers) | À créer |
