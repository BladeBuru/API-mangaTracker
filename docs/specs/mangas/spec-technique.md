# Spec Technique — Mangas

| Champ         | Valeur                                                                      |
|---------------|-----------------------------------------------------------------------------|
| Module        | mangas                                                                      |
| Version       | 0.2.0                                                                       |
| Date          | 2026-08-26                                                                  |
| Source        | Rétro-ingénierie + feat/recos-chapitres-traductions + fix/recos-by-genre-dedup (corrections revue adversariale) |

---

## Architecture du module

Le module `mangas` regroupe deux controllers, dix services, quatre entités et plusieurs DTOs. Il est découpé selon les responsabilités suivantes :

- **MangasController** : endpoints catalogue (tendances, recherche, détail, recommandations)
- **MangaCoversController** : endpoints covers (proxy redirect, refresh, sync admin)
- **MangasService** : logique métier centrale (fetch MU, cache BDD, recommandations, notes communautaires)
- **UpdateMangaService** : détection et rafraîchissement batch des données périmées
- **MangaSyncService** : synchronisation complète de toute la table `manga`
- **CoverProxyService** : résolution de l'URL upstream pour le proxy 302
- **HelperService** : utilitaires de formatage des requêtes MU
- **DescriptionTranslationService** : cache Postgres des descriptions traduites + cascade providers (DeepL / gtx) + dédup in-flight + SWR sur hash mismatch + negative-cache 5 min
- **CatalogSyncService** : orchestration de la synchronisation nightly du catalogue MU vers la table `manga`, **découpée en shards par année** (cron 03:30, budget de pages réparti entre shards, curseur de reprise par shard, statut `partial` sur erreur DB + `consecutive_failures++`)
- **CatalogShardPlannerService** : planification pure des shards (ordre, éligibilité, rafraîchissement, sous-découpage) — aucune I/O, donc testable sans mock
- **CatalogPageIngestService** : ingestion d'une page de shard (appel MU + backoff + upsert)
- **CatalogHydrationService** : job nightly d'hydratation des lignes `manga` incomplètes

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
| `src/api/mangas/catalog-sync.service.ts` | Sync nightly catalogue MU — **orchestration seule** : cron, file de shards, budget de pages, curseur, statut partial sur erreur DB | ~380 |
| `src/api/mangas/catalog-shard.ts` | Types de shard (`global` / `year` / `year_genre`) + construction du payload MU `/series/search` | ~67 |
| `src/api/mangas/catalog-shard-planner.service.ts` | Planification **pure** des shards : ordre de parcours, éligibilité, fenêtres de rafraîchissement, sous-découpage d'un shard saturé | ~237 |
| `src/api/mangas/catalog-page-ingest.service.ts` | Ingestion d'une page : appel MU + backoff 429/5xx + upsert `manga` | ~145 |
| `src/api/mangas/catalog-hydration.service.ts` | Job nightly d'hydratation des lignes `manga` incomplètes via `getMangaDetails` — **titres alternatifs (`associated`) inclus dans le critère**, priorisation bibliothèque > reco > catalogue | ~183 |
| `src/api/mangas/catalog-releases.service.ts` | **Job nocturne des dernières sorties** — curseur temporel incrémental sur `time_added`, `total_chapters` en `GREATEST`, aucune création de série | ~380 |
| `src/api/mangas/mu-release.mapper.ts` | Mapping `/releases/search` — extraction du `series_id` depuis `metadata`, parsing du champ `chapter`, dédoublonnage par série | ~164 |
| `src/api/mangas/mu-backoff.ts` | Politique de retry MU (5/10/20/40 s sur 429/5xx) **partagée** par les deux jobs nocturnes | ~60 |
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
| `src/api/mangas/constants.ts` | URLs MU (dont `/releases/search`) et liste NSFW_GENRES | ~70 |
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
| `hydration_attempted_at` | timestamptz | nullable | Dernière tentative du job `hydration` (succès OU échec). NULL = jamais tentée → priorité max. Garde anti-boucle : voir « Hydratation des lignes incomplètes » |
| `created_at` | timestamp | auto | |
| `updated_at` | timestamp | auto | Utilisé pour détecter les données périmées (> 1 jour) |

**Relation** : `manga` → `user_manga` (OneToMany via `UserManga.manga`)

**Migration** : `1787875200000-AddHydrationAttemptedAtToManga` (ajoute `hydration_attempted_at` + index `idx_manga_recommendation_recommended_mu_id`).

#### Doctrine null-safe sur les colonnes nullable

`year`, `rating`, `small_cover_url`, `medium_cover_url` et `genres` sont **protégées sur TOUS les chemins d'écriture** : elles ne sont incluses dans un `SET` que si la source MU fournit une valeur exploitable (ni `null`, ni `undefined`, ni chaîne vide). Une valeur réelle écrase toujours normalement l'ancienne — on refuse le null, on ne fige pas la donnée.

Liste unique : `PROTECTED_NULLABLE_COLUMNS` dans `manga-completeness.util.ts`, appliquée par :

| Chemin d'écriture | Mécanisme |
|-------------------|-----------|
| `CatalogPageIngestService.upsertPage` | `buildCatalogUpsertBatches` — lots par colonnes non-null (`catalog-sync.mapper.ts`) |
| `MangasService.getMangaDetails` | `buildProtectedColumnsUpdate` étalé dans le `.set()` |
| `MangaSyncService.syncAllMangasWithApi` | `buildProtectedColumnsUpdate` étalé dans le `.update()` |

**Motivation (fix 2026-08-28)** : les deux derniers faisaient un `SET` inconditionnel. Quand MU renvoie `bayesian_rating: null` (titre peu voté) ou pas d'année, ils remettaient à NULL une valeur correctement remplie par la synchro nocturne — les cartes de recommandations reperdaient leur année et leurs étoiles à chaque consultation de fiche.

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
| `job_name` | varchar | UNIQUE NOT NULL | Clé du shard. Noms **fixes** : `catalog:rating`, `catalog:week_pos`, `hydration`, `releases`. Noms **dynamiques** : `catalog:year:<AAAA>`, `catalog:year:<AAAA>:genre:<Genre>` |
| `last_completed_page` | integer | DEFAULT 0 | Curseur de reprise **propre au shard** — jamais réinitialisé globalement |
| `total_pages` | integer | nullable | Connu après la 1re réponse MU |
| `last_run_at` | timestamptz | nullable | Date du dernier run, **complet ou non** |
| `last_run_status` | varchar | nullable | `completed`, `partial`, `failed` |
| `consecutive_failures` | integer | DEFAULT 0 | Remis à 0 sur passe complétée ; incrémenté sur erreur DB (sans sauter la passe) |
| `completed_at` | timestamptz | nullable | Date de la dernière complétion **intégrale** du shard (dernière page atteinte). NULL = jamais terminé ou parcours en cours. **Pivot de la reprise inter-shards** — distinct de `last_run_at`, voir « Pattern catalogue nightly » |
| `saturated` | boolean | DEFAULT false | `true` quand la requête du shard atteint le plafond `total_hits` de MU (10 000) : réponse tronquée → sous-découpage par genre |
| `total_hits` | integer | nullable | Dernier `total_hits` annoncé par MU — diagnostic + détection de saturation |
| `cursor_time_added` | bigint | nullable | **Curseur temporel du job `releases`** : plus grand `time_added.timestamp` (epoch secondes) déjà traité. NULL partout ailleurs. `bigint` car un epoch secondes dépasse `int4` en 2038 |
| `created_at` | timestamp | auto | |
| `updated_at` | timestamp | auto | |

**Une ligne par shard** (et non plus 3 lignes fixes) : ~100 shards annuels (année courante → 1930) + les passes globales + `hydration`, auxquels s'ajoutent des sous-shards par genre **uniquement si une année sature**.

**Migrations** : `1753300000000-CreateCatalogSyncState`, `1787961600000-AddShardingToCatalogSyncState` (ajoute `completed_at`, `saturated`, `total_hits`) puis `1788048000000-AddReleasesCursorToCatalogSyncState` (ajoute `cursor_time_added`). Cette dernière est additive et idempotente (`hasColumn`) → sûre avec `migrationsRun: true` en production. Les 3 lignes existantes reçoivent `completed_at = NULL` et `saturated = false`, ce qui les rend éligibles au prochain run : le comportement au premier démarrage est « reprendre le travail », pas « tout recommencer ».

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
| `CATALOG_SYNC_MAX_PAGES` | — | **DÉPRÉCIÉE ET IGNORÉE** depuis le découpage par année. Elle servait de plafond **absolu** de pagination dans `effectiveLastPage()` : la passe s'arrêtait page 50, se déclarait `completed` et remettait le curseur à 0 — le curseur ne pouvait donc structurellement jamais dépasser la page 50, et les mêmes ~5 000 titres étaient réingérés chaque nuit. Si la variable est encore définie, un `warn` est loggé au démarrage pour qu'un opérateur ne croie pas piloter la pagination avec |
| `CATALOG_SYNC_PAGES_PER_RUN` | `60` | Budget de pages par nuit, **réparti entre les shards** de la file — c'est le **seul vrai frein** au débit de la synchro |
| `CATALOG_SYNC_YEAR_FLOOR` | `1930` | Année la plus ancienne shardée. Mesuré : 1900 / 1910 / 1920 / 1925 → 0 hit, 1930 → 1, 1935 → 2, 1950 → 4 |
| `CATALOG_SYNC_SHARD_REFRESH_DAYS` | `30` | Délai avant de re-parcourir un shard terminé. Les shards « chauds » (passes globales, année courante et précédente) utilisent 7 j en dur |
| `CATALOG_SYNC_DELAY_MS` | `2000` | Délai entre 2 appels MU (30 req/min = 50 % du plafond MU anonyme) |
| `RELEASES_SYNC_ENABLED` | `true` (`false` si `NODE_ENV=test`) | Active/désactive le cron des dernières sorties |
| `RELEASES_SYNC_MAX_PAGES` | `20` | Plafond DUR de pages MU par run du job sorties. 3 pages suffisent en régime établi (267 sorties/jour mesurées) ; le plafond ne sert qu'à borner un rattrapage après une longue indisponibilité — sans lui, un curseur périmé de plusieurs semaines ferait paginer le job sans fin |
| `RELEASES_SYNC_LOOKBACK_DAYS` | `7` | Fenêtre de rattrapage au **tout premier run** (curseur NULL). On ne remonte pas tout l'historique MU : le but du job est de ne pas rater les NOUVEAUX chapitres, pas de reconstruire le passé (l'hydratation et le signalement communautaire s'en chargent) |
| `CATALOG_SYNC_HYDRATION_BUDGET` | `800` | Appels `getMangaDetails` max/nuit pour hydrater les lignes `manga` incomplètes. 800 × 2 s ≈ 27 min à 30 req/min, soit la moitié du plafond MU anonyme (~60 req/min). Relevé de 200 → 800 le 2026-08-28 : avec le critère élargi, 200/nuit mettait plusieurs semaines à rattraper le stock |

---

## Patterns identifiés

### Pattern stub-then-fill

L'entité `Manga` a deux états de vie :
1. **Stub** : inséré via `saveRecommendations` avec uniquement `mu_id` + `title` (et éventuellement les covers si fournies par MU dans `series_image`). Tous les autres champs sont NULL. Insertion via `ON CONFLICT DO NOTHING`.
2. **Complet** : rempli par `getMangaDetails` qui appelle MU, mappe via `MangaDetailsDto.fromMU`, et fait un `UPDATE` en BDD.

Les deux états coexistent. Le code downstream doit tolérer les champs nullable.

**Limite structurelle** : l'endpoint MU « recommendations » d'une série ne renvoie ni année ni note. Un stub reste donc sans `year` ni `rating` tant que `getMangaDetails` n'a pas tourné dessus — d'où une carte de recommandation avec image mais sans ligne meta. Deux mécanismes de rattrapage couvrent ce trou (fix 2026-08-28) : le job nightly `hydration` ci-dessous, et l'hydratation à la demande côté recommandations (voir `docs/specs/recommendations/spec-technique.md`).

### Hydratation des lignes incomplètes (`CatalogHydrationService.hydrateIncompleteRows`)

Job nightly `hydration` (ex-`hydrateMissingGenres`, généralisé le 2026-08-28), extrait de `CatalogSyncService` avec le découpage par année : les deux jobs partagent la contrainte de débit MU mais rien d'autre — l'un pagine une recherche, l'autre complète des lignes une par une.

| Aspect | Comportement |
|--------|--------------|
| **Critère** | `genres IS NULL OR rating IS NULL OR year IS NULL OR medium_cover_url IS NULL OR associated IS NULL` — tout ce qui manque à une carte **ou à une fiche**, plus seulement les genres |
| **Priorité 1** | `mu_id` présent dans une bibliothèque utilisateur (`user_manga`), puis dans `manga_recommendation` (les titres réellement vus par les utilisateurs) |
| **Priorité 2** | `hydration_attempted_at ASC NULLS FIRST` — jamais tentée d'abord |
| **Garde anti-boucle** | `hydration_attempted_at IS NULL OR < now() - 30 j`, horodatée après CHAQUE tentative (succès **ou** échec) |
| **Budget** | `CATALOG_SYNC_HYDRATION_BUDGET` (défaut 800), 1 appel / `CATALOG_SYNC_DELAY_MS` |

**Ancien tri supprimé** : `ORDER BY rating DESC NULLS LAST` enterrait précisément les lignes à réparer (un stub a `rating` NULL par construction, il passait donc derrière les ~5000 lignes du catalogue) et une ligne « genres OK / rating NULL » n'était jamais reprise — le système ne se rattrapait jamais seul.

**Pourquoi une colonne dédiée plutôt que `updated_at < now() - 30 j`** : un stub fraîchement créé a un `updated_at` récent et serait exclu 30 jours alors que c'est exactement la ligne à réparer en priorité. `hydration_attempted_at` est aussi découplée des écritures sans rapport (refresh covers, report chapitres) qui repousseraient l'hydratation par effet de bord. C'est la garde la plus simple qui garantit réellement la progression du job d'une nuit à l'autre.

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

### Pattern catalogue nightly découpé en shards par année (CatalogSyncService)

Cron `03:30` + jitter aléatoire 0-15 min. Anti-réentrance par flag `running` in-process (un seul process API en prod ; à remplacer par un `pg_advisory_lock` si l'API passe multi-instance).

#### Le problème corrigé (2026-08-28)

Deux plafonds se cumulaient et figeaient le catalogue :

| Plafond | Effet mesuré |
|---------|--------------|
| `total_hits` de `/series/search` est plafonné à **10 000** quelle que soit la requête | page 100 OK, page 200 → 500, page 401 → 400. Le corpus atteignable **par requête** est donc de 10 000 titres maximum |
| `CATALOG_SYNC_MAX_PAGES` (50) servait de **plafond absolu de pagination** dans `effectiveLastPage()` | la passe atteignait son plafond, se déclarait `completed`, remettait le curseur à 0 — et réingérait éternellement les mêmes ~5 000 titres. La prod contenait 5 055 mangas |

Le curseur ne pouvait donc **structurellement** jamais dépasser la page 50. Le second plafond a été supprimé, le premier est contourné par le découpage.

#### Pourquoi l'année comme axe de découpage

Mesures du 2026-08-28 sur `/series/search` :

| Requête | `total_hits` |
|---------|-------------|
| `{year: 2000}` — sans exclusion NSFW | 2 805 |
| `{year: 2015}` — sans exclusion NSFW | 9 070 |
| `{year: 2024}` — sans exclusion NSFW | 10 000 — **saturé** |
| `{genre: ['Action'], year: 2024}` | 1 264 |
| `{year: 2015}` — **avec** l'`exclude_genre` NSFW réellement utilisé en prod | 4 781 |
| `{year: 2024}` — **avec** l'`exclude_genre` NSFW réellement utilisé en prod | 7 124 |

Toutes les requêtes catalogue portent l'`exclude_genre` NSFW : **aucune année ne sature actuellement**. Le sous-découpage par genre est donc un filet de sécurité, pas le régime nominal.

Le paramètre `letter` a été écarté **par la mesure** : `{letter: 'A'}` sature à 10 000, il ne découpe rien.

**Bornes** : plancher **1930** (mesuré : 1900 / 1910 / 1920 / 1925 → 0 hit, 1930 → 1, 1935 → 2, 1950 → 4 — descendre plus bas coûterait une requête par année pour zéro titre), plafond = année courante.

**Ordre de parcours décroissant** (année courante → 1930) : la base existante était un top-5000 par note, biaisé vers les classiques. Ce sont les années récentes qui apportent le plus de titres réellement nouveaux, et capter les nouveautés est l'objectif de fond. Le mécanisme de reprise est indifférent au sens de parcours — inverser la boucle de `buildYearShards` suffirait à repasser en ascendant.

**La passe globale `catalog:rating` est conservée** malgré le découpage : les titres dont MU ne connaît pas l'année ne sont atteignables par **aucun** shard annuel, elle est leur seul filet.

#### Reprise inter-shards

Chaque shard porte **sa propre ligne `catalog_sync_state` et son propre curseur**, jamais réinitialisé globalement. La file est reconstruite à chaque run par `CatalogShardPlannerService.planQueue` et exclut les shards terminés encore frais : le premier shard restant est donc exactement celui sur lequel la nuit précédente s'est arrêtée, curseur intact.

`completed_at` est le pivot de ce mécanisme. Il est distinct de `last_run_at`, horodaté à **chaque** run, complet ou non — c'est pourquoi ce dernier ne peut pas servir à décider d'une reprise.

**Rafraîchissement** : un shard terminé est re-parcouru après `CATALOG_SYNC_SHARD_REFRESH_DAYS` (30 j). Exception pour les shards « chauds » — passes globales, année courante et année précédente — qui utilisent une fenêtre de **7 j** : c'est là qu'apparaissent les nouveautés et que les notes bougent encore. Les années anciennes ne bougent quasiment plus ; les re-parcourir souvent gaspillerait le budget au détriment des années jamais visitées.

#### Sous-découpage d'un shard saturé

Si un shard annuel atteint 10 000 hits, il est marqué `saturated` et découpé en **un sous-shard par genre non-NSFW** : 30 genres (`MU_SHARDABLE_GENRES`, source `GET /v1/genres` = 36 genres moins les 6 de `NSFW_GENRES`, déjà exclus de toutes les requêtes — les inclure produirait des sous-shards systématiquement vides).

**Récursion limitée à 2 niveaux** : un sous-shard année × genre encore saturé produit un `warn` explicite (trou de couverture réel, titres hors de portée) et n'est **pas** re-découpé — MU n'offre pas de filtre permettant de descendre plus bas.

#### Plafonds de pagination et politique réseau

Le seul plafond de pagination est désormais `ceil(total_hits / 100)`, borné par `MU_PAGE_HARD_CAP` (400) et par l'éventuel `pageCap` propre au shard (`catalog:week_pos` : 10 pages — le top hebdo n'a de sens que sur ses premières pages). Vérifié sur `{year: 2015}` (4 781 hits) : la page 48 renvoie 81 records et la page 49 renvoie 0 record **sans erreur**. `CATALOG_SYNC_PAGES_PER_RUN` reste le seul vrai frein, réparti entre les shards de la file.

**Politique réseau inchangée** : 1 appel / `CATALOG_SYNC_DELAY_MS` (2 s, soit 30 req/min = 50 % du plafond MU anonyme), backoff 5/10/20/40 s sur 429/5xx (4 retries). Sur backoff épuisé, erreur non-retryable **ou** erreur DB : arrêt propre — curseur conservé, statut `partial`, `consecutive_failures` incrémenté, exception non propagée pour ne pas sauter les shards suivants du run (correction adversariale d8641f4) — l'ancien comportement loggait l'erreur mais poursuivait sans mettre à jour l'état.

**Stratégie upsert catalogue** (`catalog-sync.mapper.ts`) : lots séparés pour les records avec/sans genres — le lot sans genres n'inclut pas `genres` dans `orUpdate` (les genres existants ne sont jamais écrasés par null). Les colonnes `rating`, `year`, `small_cover_url`, `medium_cover_url` ne sont jamais écrasées par null : seules les valeurs non-null du record MU sont incluses dans `orUpdate` (correction adversariale d8641f4).

#### Le champ `associated` n'existe pas dans le payload search (résultat négatif)

Vérifié le 2026-08-28 sur la forme de requête **exacte** d'un shard (`orderby: rating` + `exclude_genre` NSFW + `year`) : les clés d'un `record` de `/series/search` sont exactement `series_id`, `title`, `url`, `description`, `image`, `type`, `year`, `bayesian_rating`, `rating_votes`, `genres`, `last_updated`. **Pas de champ `associated`.**

Conséquence : les titres alternatifs ne sont alimentables **que** par `getMangaDetails` (endpoint `/series/{id}`) — ce qui explique que seuls 117 mangas sur 5 055 en aient en base. La colonne `associated` reste donc volontairement hors du `orUpdate` de l'upsert catalogue : la synchro nocturne ne peut ni la remplir ni l'écraser.

Documenté ici pour éviter de ré-investiguer : ce n'est pas un oubli de mapping, c'est une limite de l'endpoint.

### Pattern job nocturne des dernières sorties (CatalogReleasesService)

**Besoin** : « synchroniser les dernières sorties, c'est primordial » — ne pas rater les nouveaux chapitres.

`manga.total_chapters` n'était alimenté que par `getMangaDetails` (ouverture d'une fiche) et par `ChapterReportService` (signalement communautaire) : autrement dit, **uniquement sur les titres que quelqu'un consultait déjà**. D'où les remontées « MangaUpdates est en retard sur le nombre de chapitres », qui n'étaient pas un retard de MU mais un retard de **notre** copie. Ce job lit le flux des sorties et fait monter `total_chapters` sur **tout le catalogue en base**, chaque nuit, sans intervention utilisateur.

#### Sémantique de l'API vérifiée (mesures du 2026-08-29)

| Constat | Détail |
|---------|--------|
| **`record.id` n'est PAS le `series_id`** | C'est l'id de la **sortie** (~1 262 426, incrémental). Les `series_id` MU sont des entiers à 11 chiffres (ex. 64156727159) et `GET /v1/series/1262426` répond **404**. Un mapping qui aurait confondu les deux n'aurait jamais rapproché la moindre ligne — **en silence** |
| **`series_id` ⇒ `include_metadata: true`** | Le vrai identifiant n'apparaît que sous `metadata.series.series_id` (100/100 records d'une page). Sans ce paramètre, la réponse ne contient **aucune** clé de rapprochement avec `manga.mu_id` |
| **`time_added` est un OBJET** | `{ timestamp: 1787934483, as_rfc3339: '…', as_string: '…' }`. Le curseur utilise `timestamp` (epoch secondes). `as_rfc3339` porte un décalage PDT qui en ferait un curseur fragile |
| **`orderby` ∈ {date, time, title, vol, chap}** | `time` (date d'ajout MU) est **strictement décroissant** — vérifié sur 100 records consécutifs |
| **`release_date` inexploitable** | La base MU contient des dates aberrantes saisies à la main : `0001-07-05`, `1111-11-11`, `0004-04-07` (observées en tri ascendant). Seul `time_added` est monotone |
| **Volume** | 267 sorties sur une journée pleine (2026-08-26) → **3 pages de 100 par nuit**, soit ~6 s de requêtes |
| **Plafonds** | `perpage: 100` accepté ; `total_hits` plafonné à 10 000 comme sur `/series/search` |

#### Incrémentalité

Le job pagine du plus récent au plus ancien (`orderby: 'time'`) et s'arrête dès qu'une page ne contient plus rien de postérieur à `cursor_time_added`.

**Aucune sortie ne peut être manquée** : de nouvelles sorties insérées pendant le run n'apparaissent qu'en **tête** de tri et décalent les suivantes vers le bas. On peut donc revoir un enregistrement — sans effet, l'écriture est idempotente — mais jamais en sauter un.

**Le curseur n'avance QUE sur un run intégralement réussi.** Le parcours allant du plus récent au plus ancien, un échec en page 3 laisse les sorties des pages 3+ (les plus **anciennes**, donc les plus proches du curseur) non traitées : avancer le curseur au plus récent les enterrerait définitivement. On préfère re-parcourir la fenêtre au prochain run.

#### Écriture

| Aspect | Comportement |
|--------|--------------|
| **Colonne écrite** | `total_chapters` **uniquement** — aucune autre colonne n'entre dans le `SET` |
| **Invariant A-5** | `GREATEST(total_chapters, :newTotal)` — monotone croissant. Une sortie isolée d'un vieux chapitre (rescan, retraduction) ne fait jamais régresser un total plus élevé |
| **Parsing `chapter`** | Chaîne libre saisie par les groupes. Plage `A-B` → **B** (« 12-13 » = le chapitre 13 est paru) ; sinon **premier nombre en tête** (`12.5` → 12, `18b` → 18, `112 + Afterword 1-3` → 112). Le « premier nombre » plutôt qu'un `max` sur toute la chaîne est délibéré : `5 (of 10)` doit donner 5. **On préfère sous-estimer** — une sous-estimation se corrige au passage suivant, une surestimation est définitive |
| **Dédoublonnage** | Une série qui sort plusieurs chapitres dans la fenêtre ne produit qu'un seul UPDATE, au plus haut numéro |
| **Séries inconnues** | **Jamais créées.** Voir ci-dessous |

**Pourquoi aucune insertion en stub** (décision, pas raccourci) : `/releases/search` n'applique pas l'`exclude_genre` NSFW du catalogue et ne fournit **ni année, ni note, ni genres**. Insérer des stubs depuis ce flux polluerait `manga` de séries NSFW et de lignes vides qui (a) entreraient dans les pools de recommandation, (b) consommeraient le budget d'hydratation — au détriment des titres réellement vus par les utilisateurs. La découverte reste le métier du catalogue.

#### Politique réseau

Rythme et backoff **inchangés** : 1 requête / `CATALOG_SYNC_DELAY_MS` (2 s), backoff 5/10/20/40 s sur 429/5xx, extraits dans `mu-backoff.ts` et **partagés** avec le catalogue — deux jobs frappent désormais MU en nocturne, dupliquer la boucle aurait ouvert la porte à une divergence silencieuse sur le point le plus sensible du projet.

**Séparation dans la nuit** : sorties à **02:00** (+ jitter 0-10 min), catalogue à **03:30** (+ jitter 0-15 min). Les deux ne frappent donc jamais MU simultanément. Pire cas du job sorties : 20 pages × (2 s + 75 s de backoff complet) ≈ **26 min**, contre 90 min de marge avant le catalogue.

---

### Dimensionnement de l'hydratation (titres alternatifs inclus)

**Le point structurant** : `associated` n'est PAS dans `/series/search` — il faut ouvrir `/v1/series/{id}`, soit **1 requête par manga**. Or c'est exactement l'appel que `CatalogHydrationService` fait déjà, et cet appel ramène `associated` **dans la même réponse** que genres/rating/année/cover.

**Un job dédié aux titres alternatifs aurait donc tapé une seconde fois la même fiche pour une donnée déjà reçue** : le double du budget réseau pour zéro information supplémentaire, sur l'API qu'il faut justement ménager. D'où l'élargissement du critère existant (`associated IS NULL`) plutôt qu'un nouveau service.

#### Combien de nuits ?

Corpus atteignable **131 185 titres** (mesuré année par année, NSFW exclu) ; base de prod actuelle **5 055 lignes**. À 1 fiche / 2 s, couvrir 131 185 fiches représente **~73 h de requêtes**, à étaler.

| `CATALOG_SYNC_HYDRATION_BUDGET` | Durée/nuit | Nuits pour 131 185 | Nuits pour les 5 055 actuelles |
|---|---|---|---|
| 800 (défaut) | 27 min | **164** (~5,5 mois) | 7 |
| 1 500 | 50 min | 88 (~3 mois) | 4 |
| 2 000 | 67 min | **66** (~2,2 mois) | 3 |
| 3 000 | 100 min | 44 (~1,5 mois) | 2 |
| 5 000 | 167 min | 27 (~1 mois) | 2 |

Le corpus n'est pas hydratable avant d'être **en base** : le catalogue doit d'abord ingérer les 131 185 titres, soit 1 312 pages à 60 pages/nuit ≈ **22 nuits**. Les deux jobs progressent en parallèle.

**Charge MU par nuit aux valeurs par défaut** : sorties ~6 s + catalogue 60 pages ≈ 2 min + hydratation 800 fiches ≈ 27 min ≈ **30 min de requêtes**, toujours à 30 req/min (50 % du plafond anonyme). Il reste donc une marge confortable pour relever le budget : **2 000 est recommandé** (67 min/nuit, corpus complet en ~66 nuits) sans changer le rythme d'une seule requête. « C'est pas grave si c'est étalé sur plusieurs jours ou semaines » — mais ne pas se faire bannir reste l'exigence n°1, et **le rythme (1 req / 2 s) ne bouge jamais** : seul le nombre de fiches par nuit est ajustable.

#### Critère et priorisation

| Aspect | Comportement |
|--------|--------------|
| **Critère** | `genres IS NULL OR rating IS NULL OR year IS NULL OR medium_cover_url IS NULL OR associated IS NULL` |
| **Appel par ligne** | **Un seul** `getMangaDetails`, quel que soit le nombre de champs manquants |
| **Priorité 0** | `mu_id` présent dans une bibliothèque utilisateur (`user_manga`) — le signal d'usage le plus fort |
| **Priorité 1** | `mu_id` présent dans `manga_recommendation` — titres affichés sur des cartes |
| **Priorité 2** | Reste du catalogue |
| **Garde anti-boucle** | `hydration_attempted_at IS NULL OR < now() - 30 j`, horodatée après CHAQUE tentative |

**Conséquence assumée sur `associated`** : une série qui n'a réellement aucun titre alternatif garde `associated = NULL` (l'écriture est null-safe et n'enregistre pas `[]`) et reste éligible. C'est `hydration_attempted_at` qui l'empêche de brûler le budget en boucle — exactement le traitement déjà réservé à un titre sans note ni année.

**Écriture null-safe** (`buildAssociatedUpdate`) : `MangaDetailsDto.fromMU` applique `muObject['associated'] ?? []`, donc une réponse MU sans le champ produit un tableau **vide**. L'UPDATE de `getMangaDetails` l'écrivait sans condition : une fiche déjà pourvue pouvait **perdre** ses titres alternatifs. La colonne n'entre désormais dans le `SET` que si MU fournit au moins un titre.

---

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
| `src/api/mangas/catalog-releases.service.spec.ts` | Job des sorties : incrémentalité du curseur (traite uniquement le postérieur, avance au plus récent vu, 2e passage idempotent, fenêtre bornée au 1er run), monotonie `GREATEST` et aucune autre colonne au `SET`, séries inconnues ignorées sans stub, plafond de pages, cadence 1 req / 2 s, backoff 5/10/20/40 s avec **curseur conservé** après échec réseau ou DB, anti-réentrance | ✅ |
| `src/api/mangas/mu-release.mapper.spec.ts` | Parsing du champ `chapter` sur ses formes réelles (entier, plage `12-13` → borne haute, `12.5`, `18b`, `112 + Afterword 1-3`, `5 (of 10)` → 5), `series_id` lu depuis `metadata` et jamais depuis `record.id`, dédoublonnage par série | ✅ |
| `src/api/mangas/catalog-hydration.service.spec.ts` | Critère élargi (`associated IS NULL` compris), **un seul appel de fiche par ligne**, budget nocturne respecté, priorisation bibliothèque > reco > reste, garde anti-boucle | ✅ |
| `src/api/mangas/manga-completeness.util.spec.ts` | Doctrine null-safe, dont `buildAssociatedUpdate` : la colonne est omise sur `[]` / null → une fiche déjà pourvue ne peut plus perdre ses titres alternatifs | ✅ |
