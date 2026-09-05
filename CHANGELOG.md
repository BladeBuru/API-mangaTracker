# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.
Format : [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/) · Versioning : [SemVer](https://semver.org/lang/fr/).

---

## [Unreleased] — feat/auto-status-en-cours

> Base `d7fd6fd`. Dépendance client : l'app Flutter `feat/auto-status-en-cours` (bascule locale + reflet UI). **Déployer l'API avant l'app.**

### Added
- **library** : **bascule automatique « à jour » → « en cours »**. Le besoin, dans les mots du propriétaire : *« si on détecte un nouveau chapitre sur un manga que j'ai marqué "à jour", c'est qu'on n'est plus à jour : on est "en cours". Le statut doit automatiquement changer. »* Exemple : lu jusqu'au 39, statut « à jour » ; le 40 paraît → « en cours ». Jusqu'ici la sync nocturne des sorties faisait bien monter `total_chapters`, mais **aucun statut ne suivait** : en prod, 3 entrées « à jour » étaient en réalité en retard de 22, 26 et 58 chapitres
- **library** : `ReadingStatusAutoUpdateService.flipCaughtUpToReading(muId)` — **une seule requête UPDATE ensembliste par manga** (`manga_id = X AND "readingStatus" = 'caughtUp' AND user_read_chapters < total en base`), jamais de boucle par utilisateur. `lastUpdated` mis à jour → l'entrée remonte en tête de bibliothèque. Plan vérifié en prod (`EXPLAIN`, sans écriture) : index `idx_user_manga_manga_id` + sous-requête indexée sur `manga.mu_id`. Best-effort : une erreur BDD est journalisée (`Logger.error`) et renvoie 0 — le total, déjà écrit, reste la source de vérité ; ni la fiche détail, ni le job, ni le signalement n'échouent à cause de cet effet secondaire. Log `Logger` du nombre de lignes basculées

### Changed
- **Branché sur les trois chemins qui font monter `manga.total_chapters`** — tous, pas un de plus, pour que la règle vaille aussi **app fermée** :
  1. `CatalogReleasesService.applyUpdates` (sorties MU, cron 02:00) — nouveau compteur `statusFlips` dans le bilan et le log du run
  2. `ChapterReportService.consolidate` (signalement communautaire ≥ 2 lecteurs)
  3. `MangasService.getMangaDetails` (rafraîchissement des détails) — couvre par construction `LibraryService.checkManga` (refresh 6 h), `UpdateMangaService` (refresh en lot de la bibliothèque, refresh des covers) et `MangaSyncService`, qui passent tous par lui. Leurs propres écritures `GREATEST` reçoivent le **même** total → aucune double bascule
- **Déclenchement UNIQUEMENT sur hausse effective du total.** Les UPDATE `GREATEST` des chemins 1 et 2 reçoivent une garde `total_chapters < :newTotal` (sans effet sur le résultat, GREATEST y est déjà idempotent) pour que `affected` dise si le total a **réellement** monté ; le chemin 3 pré-lit le total (SELECT indexé sur `mu_id` unique, négligeable devant l'appel MU). Conséquence voulue : un lecteur qui s'est déclaré « à jour » **volontairement** en retard sur le total MU (scans FR en retard sur les raws, par exemple) n'est **pas** ramené en boucle à « en cours » à chaque refresh 6 h — seule la parution d'un nouveau chapitre le fait. Un chemin concurrent qui a monté le total juste avant a déjà déclenché la bascule (`affected = 0` → rien)
- Périmètre strict : **seul `caughtUp` bascule**. `completed` (manga terminé ET lu en entier) et `readLater` ne bougent jamais — l'app ne connaît ni « abandonné » ni « en pause ». Le passage inverse (`updateChapter` → `caughtUp` / `completed` quand la progression atteint le total effectif) est **inchangé**

### Vérifié en prod (lecture seule, 2026-09-05)
- Valeurs de `user_manga."readingStatus"` : `reading` 65 · `readLater` 9 · `caughtUp` 7 · `completed` 6. « À jour » = `caughtUp`, « en cours » = `reading` (enum API `src/api/library/reading-status.enum.ts`, enum Flutter `reading_status.enum.dart`)
- **3 lignes** (2 utilisateurs, 3 mangas) sont aujourd'hui `caughtUp` avec `user_read_chapters < manga.total_chapters` (retards de 22, 26 et 58 chapitres). Elles basculeront à la **prochaine hausse** de leur total (pas au déploiement : aucune migration de données, par choix — cf. « hausse effective » ci-dessus). Aucune ligne `completed` en retard

### BDD
- Aucune migration : pas de changement de schéma. L'index `idx_user_manga_manga_id` (migration `1788048000000`) porte la requête

### Tests
- +15 tests unitaires (282 → 297) : service (requête ensembliste, clauses, `affected` absent, erreur BDD avalée, log), job sorties (garde `total_chapters < :newTotal`, bascule **uniquement** pour les séries dont le total a monté, jamais pour une série inconnue, compteur du bilan), consolidation (bascule quand 1 ligne `manga` touchée, rien quand 0), détails (39 → 40 bascule ; 40 → 40 et 90 → 79 ne basculent pas ; fiche inconnue en base ne bascule pas)

## [Unreleased] — fix/google-web-coop + fix/google-web-coop-2

### Fixed
- **auth** : la connexion Google depuis le **client web** n'aboutissait pas. Helmet pose `Cross-Origin-Opener-Policy: same-origin` sur toutes les réponses ; la popup ouverte depuis `app.bladeburu.com` recevait ce COOP dès la redirection `/auth/google`, le navigateur la plaçait dans un nouveau groupe de contextes et `window.opener` valait `null` sur la page de callback — le `postMessage` des jetons ne partait jamais et l'application attendait indéfiniment. Vérifié en prod (`curl -I https://api.bladeburu.com/auth/google` → `Cross-Origin-Opener-Policy: same-origin`). Nouveau `GoogleOAuthPopupMiddleware` (COOP `unsafe-none`) appliqué **uniquement** à `GET /auth/google` et `GET /auth/google/callback` ; le reste de l'API garde le COOP strict. Tests ajoutés (`google-oauth-popup.middleware.spec.ts`, `google-oauth-popup.middleware.e2e.spec.ts`) (#78)
- **auth** : après déploiement de #78, le conteneur en production continuait de renvoyer `Cross-Origin-Opener-Policy: same-origin` sur la redirection 302 de `/auth/google` — le middleware de module s'exécutait bien, mais Passport appelait `res.end()` lui-même avant que la valeur ne parte. Nouveau `GoogleOAuthGuard` (étend `AuthGuard('google')`) qui pose le COOP dans `canActivate` juste avant la délégation à Passport ; le handler `googleCallback` le pose également directement sur la réponse. Témoins de diagnostic : `X-MT-Popup-Middleware: 1` (middleware) et `X-MT-Popup-Guard: 1` (guard), vérifiables via `curl -I`. Test unitaire ajouté (`google-oauth.guard.spec.ts`) (#80)

## [Unreleased] — feat/releases-et-titres-alt

> Part de `feat/catalogue-et-recos` (sharding par année), non mergée.

### Added
- **mangas** : **job nocturne des dernières sorties** (`CatalogReleasesService`, cron 02:00 + jitter 0-10 min). Interroge `POST /v1/releases/search` de façon **incrémentale** et fait monter `manga.total_chapters` sans qu'aucun utilisateur ait à ouvrir la fiche ni à signaler quoi que ce soit. C'est l'attaque directe du problème remonté par les utilisateurs (« MangaUpdates est en retard sur le nombre de chapitres ») : jusqu'ici `total_chapters` n'était alimenté que par `getMangaDetails` (à l'ouverture d'une fiche) et par le signalement communautaire (`ChapterReportService`) — donc uniquement sur les titres que quelqu'un consultait déjà. Le job couvre désormais **tout le catalogue en base**, chaque nuit
- **mangas** : curseur temporel `catalog_sync_state.cursor_time_added` (ligne `releases`) — le job ne récupère que ce qui est apparu depuis son dernier passage
- **mangas** : `RELEASES_SYNC_ENABLED`, `RELEASES_SYNC_MAX_PAGES` (défaut 20) et `RELEASES_SYNC_LOOKBACK_DAYS` (défaut 7) dans la spec technique
- **mangas** : `mu-backoff.ts` — politique de retry MU (5/10/20/40 s sur 429/5xx) extraite et **partagée** par les deux jobs nocturnes

### Changed
- **mangas** : le job d'hydratation (`CatalogHydrationService`) est **étendu aux titres alternatifs** au lieu de recevoir un second service. Critère élargi à `associated IS NULL`. `/v1/series/{id}` ramène **déjà** `associated` dans la même réponse que genres/rating/année/cover — un job dédié aurait tapé une **seconde fois la même fiche** pour une donnée déjà reçue, soit le double du budget réseau pour zéro information supplémentaire, sur l'API qu'il faut justement ménager
- **mangas** : priorisation de l'hydratation par **usage réel** — bibliothèque utilisateur (0) > recommandation (1) > reste du catalogue (2). Avec 131 185 fiches à couvrir, l'ordre décide de ce que les utilisateurs voient réparé les premières nuits
- **Rythme réseau inchangé** : 1 requête / 2 s (`CATALOG_SYNC_DELAY_MS`), backoff 5/10/20/40 s. Les deux jobs sont **séparés dans la nuit** (sorties 02:00, catalogue 03:30 + jitter 15 min) et ne frappent donc jamais MU simultanément — la marge est de 90 min pour un pire cas mesuré à ~26 min

### Fixed
- **mangas** : **perte possible des titres alternatifs**. `getMangaDetails` écrivait `associated` sans condition, alors que `MangaDetailsDto.fromMU` applique `muObject['associated'] ?? []` : une réponse MU sans le champ produisait un tableau **vide** qui écrasait des titres alternatifs déjà en base. La colonne passe par `buildAssociatedUpdate` (null-safe, même doctrine que `PROTECTED_NULLABLE_COLUMNS`)
- **mangas** : une requête MU inutile par run du job sorties — une page incomplète signifie la fin des résultats disponibles, la page suivante était demandée quand même

### Vérifié sur l'API MU (mesures du 2026-08-29, pas des suppositions)
- **`record.id` de `/releases/search` n'est PAS le `series_id`** — contrairement à ce qu'on pouvait supposer. C'est l'id de la **sortie** (~1 262 426, incrémental) ; les `series_id` MU sont des entiers à 11 chiffres (ex. 64156727159) et `GET /v1/series/1262426` répond **404**. Un mapping qui aurait confondu les deux n'aurait **jamais** rapproché la moindre ligne, en silence
- **Le vrai `series_id` n'arrive qu'avec `include_metadata: true`**, sous `metadata.series.series_id` (présent sur 100/100 records d'une page)
- **`time_added` est un OBJET**, pas une chaîne : `{ timestamp, as_rfc3339, as_string }`. Le curseur s'appuie sur `timestamp` (epoch secondes) ; `as_rfc3339` porte un décalage PDT qui en ferait un curseur fragile
- **`orderby` n'accepte que `{date, time, title, vol, chap}`** — `time` (date d'ajout) est strictement décroissant, vérifié sur 100 records consécutifs. `release_date` est **inexploitable** comme curseur : la base MU contient des dates aberrantes saisies à la main (`0001-07-05`, `1111-11-11`, `0004-04-07`)
- **`perpage: 100` accepté**, `total_hits` plafonné à 10 000 comme sur `/series/search`
- **Volume mesuré : 267 sorties sur une journée pleine** (2026-08-26) → **3 pages par nuit** en régime établi, soit ~6 s de requêtes
- **Formes réelles du champ `chapter`** sur 100 sorties consécutives : entier (92 %), plage `12-13` (5 %), décimal `12.5` (1 %), suffixe `18b` (1 %), composé `112 + Afterword 1-3` (1 %)

### BDD
- Migration `1788048000000-AddReleasesCursorToCatalogSyncState` : colonne `catalog_sync_state.cursor_time_added` (bigint nullable — un epoch secondes dépasse `int4` en 2038) et index `idx_user_manga_manga_id` (la priorisation de l'hydratation s'appuie sur un `EXISTS` par `user_manga.manga_id`). Additive et idempotente (`hasColumn` / `IF NOT EXISTS`). `NULL` sur les lignes existantes = « job jamais tourné » → au premier run le job se limite à une fenêtre de rattrapage bornée au lieu de remonter tout l'historique MU

### Tests
- +44 tests unitaires (216 → 260), 2 suites ajoutées : incrémentalité du curseur (traite uniquement le postérieur, avance au plus récent vu, second passage idempotent, fenêtre bornée au premier run), monotonie de `total_chapters` (assertion sur le SQL `GREATEST` **et** sur le fait qu'aucune autre colonne n'entre dans le `SET`), séries inconnues ignorées sans insertion de stub, plafond de pages, cadence 1 req / 2 s, **non-régression du backoff** (429 → 5/10/20/40 s, 400 non-retryable) avec **curseur conservé** après échec réseau ou DB, anti-réentrance, parsing du champ `chapter` sur ses formes réelles, sélection « seulement si manquant » et **un seul appel de fiche par ligne**, respect du budget, priorisation bibliothèque > recommandation > reste
## [Unreleased] — feat/pas-interesse

> Part de `feat/catalogue-et-recos`. Aucun impact sur les branches catalogue en cours.

### Added
- **recommendations** : fonctionnalité **« pas intéressé / déjà vu »**. Le besoin, dans les mots de l'utilisateur : *« On me recommande One Piece et Naruto. Les deux, c'est les meilleurs, les plus connus. Sauf que moi je les ai — j'adore, mais je les ai vus en animé et je n'ai pas forcément envie de les relire. »* Aucun algorithme ne peut deviner ça : l'information n'existe ni dans MangaUpdates, ni dans la bibliothèque, ni dans les notes. Elle est désormais captée explicitement
- **recommendations** : **raison typée et obligatoire** (`already_read` / `not_interested` / `seen_elsewhere`) plutôt qu'un booléen « masqué ». C'est le signal négatif qui manque cruellement au produit — la base de prod ne contient que **4 notes utilisateur pour 6 comptes**. Un booléen perdrait pour toujours la distinction entre « déjà lu, j'ai aimé » (affinité **positive** mal exploitée) et « pas intéressé » (signal **négatif** réel), les deux valeurs qu'un futur moteur de recommandation aura besoin de séparer
- **recommendations** : 3 routes, `JwtAuthGuard` + throttle **60/h par utilisateur** (tracké sur `req.user.id` et non sur l'IP — derrière NPMplus, un throttle par IP serait un budget global partagé, cf. `UserThrottlerGuard`). Quota volontairement plus large que le signalement de chapitres (10/h) : écarter des titres est un geste de tri normal, on ne vise que l'abus scripté
  - `POST /recommendations/dismissals/:muId` (body `{ reason }`)
  - `DELETE /recommendations/dismissals/:muId` (204) — l'utilisateur doit toujours pouvoir revenir sur sa décision
  - `GET /recommendations/dismissals` — rend un rejet accidentel récupérable même après la disparition du SnackBar d'annulation ; sans cette route, un titre écarté par erreur serait irrécupérable puisqu'il ne remonte plus nulle part

### Changed
- **recommendations** : **exclusion appliquée aux 8 chemins de recommandation**, via un point d'entrée unique. Le module comportait six endroits construisant leur propre exclusion de la bibliothèque ; ajouter un filtre à chacun aurait garanti d'en oublier un. Le set d'exclusion existant est donc **élargi à la source** (`DismissalService.buildExclusionSet` = biblio ∪ rejets, `libraryMuIds` renommé `excludedMuIds`) et se propage inchangé dans toutes les branches descendantes, qui n'ont pas eu à être modifiées :
  1. `GET /recommendations` (liste plate) — `buildUserRecommendations` → `scoreRecos`
  2. cold start, top communauté — `buildTopCommunityDtos` filtre les `mu_id` remontés
  3. cold start, sleepers — le **vrai `userId`** est désormais propagé
  4. `GET /recommendations/sleepers` — `NOT IN` en SQL
  5. `GET /recommendations/by-genre` (pool) — `computeScoreMap` → `scoreRecos`
  6. `GET /recommendations/by-genre` (compléments catalogue) — set transmis en 5e argument à `GenreSectionService.buildSections`
  7. candidats catalogue — `CatalogCandidateService.findCandidates`, `NOT IN` en SQL
  8. `GET /mangas/recommendations/:muId` (fiche détail) — filtrage après le merge MU + communauté
- **recommendations** : **la sentinelle `userId = -1` du cold start est abandonnée**. `buildColdStartRecommendations` appelait `findSleeperHits(-1, …)` pour dire « pas de bibliothèque à exclure ». C'était faux dès l'arrivée de cette feature : **bibliothèque vide ne veut pas dire rien à exclure** — un compte sans aucun titre peut très bien avoir déjà écarté One Piece, c'est même le cas d'usage fondateur. La sentinelle ne survit que comme garde défensive (`userId <= 0` → set vide sans requête)
- **recommendations** : `GenreSectionService.buildSections` prend le set d'exclusion en **paramètre obligatoire** au lieu de le reconstruire depuis `userMangas`. Il ne reconstituait que la bibliothèque, donc ses compléments catalogue pouvaient réintroduire un titre écarté. Paramètre obligatoire et non optionnel **par choix** : l'omettre est une erreur de compilation, pas une régression muette en production
- **mangas** : `getRecommendationsAsQuickView(muId, userId?)` — `userId` optionnel, transmis par le controller. Les appels internes sans contexte utilisateur conservent le comportement historique
- **recommendations** : le cache `RecoCacheService` est invalidé au rejet **et** à l'annulation. Sans ça, l'effet n'apparaîtrait qu'à l'expiration du TTL d'une heure — l'utilisateur écarterait un titre, rechargerait, et le reverrait

### BDD
- Migration `1788048000000-CreateUserMangaDismissal` : table `user_manga_dismissal` (`user_id`, `manga_id`, `reason`, `created_at`), FK CASCADE vers `user(id)` et `manga(mu_id)` comme `user_manga` et `manga_chapter_report`, index UNIQUE `(user_id, manga_id)` et index `(user_id)`. Création idempotente (`hasTable`), table vide au départ, aucune migration de data
- `reason` en `varchar(32)` et non en enum PostgreSQL : convention du repo (cf. `user_manga.readingStatus`), et une nouvelle valeur ne demanderait alors aucune migration
- L'index UNIQUE porte l'upsert `ON CONFLICT (user_id, manga_id) DO UPDATE SET reason` : rejeter deux fois le même titre ne crée qu'une ligne et la raison la plus récente gagne, **sans `SELECT` préalable** donc sans fenêtre de course

### Architecture
- `DismissalModule` est un micro-module autonome (TypeORM + `RecoCacheModule`), sur le modèle de `RecoCacheModule` : importable par `RecommendationModule` **et** par `MangasModule` (recos de la fiche détail) sans créer de cycle `mangas ↔ recommendations`

### Tests
- +22 tests unitaires (216 → 238), dont **un par chemin d'exclusion** pour que l'oubli d'une branche casse la CI plutôt que la prod : liste plate (le titre écarté ne remonte pas même en tête du pool), candidats catalogue (set transmis + refiltrage à l'ajout), sections par genre (set transmis à `GenreSectionService`, `NOT IN` du complément catalogue, entrée exclue ignorée dans le pool), sleepers (`NOT IN` SQL), cold start (top communauté filtré + rejets du vrai `userId` chargés), fiche détail (avec et sans `userId`, cas « toutes les recos écartées »)
- `DismissalService` : unicité par upsert, annulation, 404 sur double annulation, 404 sur manga inconnu, invalidation du cache, sentinelle `userId <= 0` sans requête, union biblio ∪ rejets, listing trié

---

## [Unreleased] — feat/catalog-sharding-by-year

> Dépend de la PR #74 (`fix/manga-data-completeness`), non mergée : cette branche en part et réécrit `catalog-sync.service.ts` par-dessus.

### Fixed
- **mangas** : le catalogue nightly réingérait éternellement les mêmes ~5 000 titres. `CATALOG_SYNC_MAX_PAGES` (50) était utilisée dans `effectiveLastPage()` comme **plafond absolu de pagination** et non comme budget par run : la passe `catalog:rating` parcourait les pages 1→50, atteignait son plafond, se déclarait `completed` et remettait le curseur à 0. Le curseur ne pouvait **structurellement jamais dépasser la page 50**, alors que la requête exposait 100 pages. Constat en prod : 5 055 mangas en base, `catalog:rating` avec `last_completed_page = 0` / `total_pages = 100` / statut `completed`. Le seul plafond de pagination est désormais le plafond RÉEL de la requête (`ceil(total_hits/100)`) borné par `MU_PAGE_HARD_CAP` (400)

### Added
- **mangas** : **découpage du catalogue MU par année de publication**. `total_hits` de `/series/search` est plafonné à 10 000 quelle que soit la requête (mesuré : page 100 OK, page 200 → 500, page 401 → 400) — une passe globale ne peut donc pas voir au-delà de 10 000 titres. Une passe par année (`catalog:year:<AAAA>`, de l'année courante jusqu'au plancher **1930**) ramène chaque requête sous ce plafond et rend l'ensemble du catalogue atteignable. Mesures du 2026-08-28 : `{year:2000}` → 2 805 hits, `{year:2015}` → 9 070, `{year:2024}` → 10 000 (saturé) ; avec l'`exclude_genre` NSFW réellement appliqué en prod, `{year:2015}` → 4 781 et `{year:2024}` → 7 124, donc **aucune année ne sature aujourd'hui**. Le paramètre `letter` a été écarté **par la mesure** : `{letter:'A'}` sature à 10 000, il ne découpe rien
- **mangas** : **curseur par shard, jamais réinitialisé globalement**. Chaque shard porte sa propre ligne `catalog_sync_state` et son propre curseur. La file est reconstruite à chaque run et exclut les shards terminés encore frais → le premier shard restant est celui où la nuit précédente s'est arrêtée. Une nuit qui finit 2001 et entame 2000 est reprise à 2000 la nuit suivante, sans re-parcourir les années déjà faites
- **mangas** : **rafraîchissement périodique** — un shard terminé est re-parcouru après `CATALOG_SYNC_SHARD_REFRESH_DAYS` (défaut 30 j), sauf les shards « chauds » (passes globales + année courante et précédente) qui utilisent une fenêtre de 7 j. L'objectif à terme est de capter les nouveautés, pas de tout refaire chaque nuit
- **mangas** : **sous-découpage automatique à la saturation** — un shard annuel qui atteint 10 000 hits est marqué `saturated` et découpé en un sous-shard par genre non-NSFW (`catalog:year:<AAAA>:genre:<Genre>`, 30 genres = les 36 de `GET /v1/genres` moins les 6 NSFW déjà exclus). **Récursion limitée à 2 niveaux** : un sous-shard année × genre encore saturé produit un warn explicite et n'est pas re-découpé
- **mangas** : `CATALOG_SYNC_YEAR_FLOOR` (défaut 1930) et `CATALOG_SYNC_SHARD_REFRESH_DAYS` (défaut 30) dans `template.env` et la spec technique

### Changed
- **mangas** : les deux notions confondues sont séparées. `CATALOG_SYNC_PAGES_PER_RUN` = budget de pages par nuit **réparti entre les shards** (le seul vrai frein) ; `CATALOG_SYNC_MAX_PAGES` est **dépréciée et ignorée**, un warn est loggé au démarrage si elle est encore définie, et elle est retirée de `template.env` pour qu'un opérateur ne croie pas piloter la pagination avec
- **mangas** : parcours **décroissant** (année courante → 1930). La base était un top-5 000 par note biaisé vers les classiques : les années récentes apportent le plus de titres réellement nouveaux, et capter les nouveautés est l'objectif de fond. Le mécanisme de reprise est indifférent au sens de parcours
- **mangas** : la passe globale `catalog:rating` est **conservée** malgré le découpage — c'est le seul filet pour les titres dont MU ne connaît pas l'année, qu'aucun shard annuel ne peut atteindre
- **mangas** : `catalog-sync.service.ts` (468 lignes) découpé pour tenir la limite de 400 du repo → `CatalogShardPlannerService` (planification **pure** : ordre, éligibilité, rafraîchissement, sous-découpage — testable sans mock de repository ni de réseau), `CatalogPageIngestService` (appel MU + backoff + upsert), `CatalogHydrationService` (job d'hydratation, comportement inchangé), et `catalog-shard.ts` (types + construction du payload). Le service de sync ne garde que l'orchestration (380 lignes)
- **Rythme réseau inchangé** : 1 requête / 2 s (`CATALOG_SYNC_DELAY_MS`), backoff 5/10/20/40 s sur 429/5xx. Le découpage n'accélère rien — il étale la couverture sur plusieurs nuits

### BDD
- Migration `1787961600000-AddShardingToCatalogSyncState` : colonnes `catalog_sync_state.completed_at` (timestamptz nullable, pivot de la reprise inter-shards — distinct de `last_run_at` qui est horodaté à chaque run complet ou non), `saturated` (boolean défaut false) et `total_hits` (int nullable). Additive et idempotente (`hasColumn`). Les 3 lignes existantes reçoivent `completed_at = NULL` → elles sont éligibles au premier run, donc le comportement au démarrage est « reprendre le travail », pas « tout recommencer »

### Vérifié / non retenu
- **`associated` n'est PAS alimentable depuis `/series/search`** — vérifié le 2026-08-28 sur la forme de requête exacte du shard (`orderby: rating` + `exclude_genre` + `year`). Les clés d'un `record` sont exactement `series_id, title, url, description, image, type, year, bayesian_rating, rating_votes, genres, last_updated` : aucun champ de titres alternatifs. C'est ce qui explique que seuls 117 mangas sur 5 055 en aient en base — ils ne sont remplis que par `getMangaDetails` (`/series/{id}`), à l'ouverture d'une fiche. La colonne `associated` reste donc hors du `orUpdate` de l'upsert catalogue, et **aucune persistance n'a été ajoutée**

### Tests
- +33 tests unitaires (182 → 215), répartis sur 4 suites : planification pure (composition de la file, plancher, ordre décroissant, week_pos le dimanche uniquement), **reprise inter-shards sur plusieurs nuits** (la nuit 2 repart sur le shard laissé en cours sans re-parcourir les terminés), fenêtres de rafraîchissement (7 j vs 30 j), détection de saturation et sous-découpage (dont la limite à 2 niveaux), **budget de pages global à la nuit et non par shard**, non-régression du backoff (429 → 4 retries 5/10/20/40 s, 5xx, 400 non-retryable) et de la doctrine null-safe de l'upsert. Test dédié au bug corrigé : 100 pages parcourues malgré `CATALOG_SYNC_MAX_PAGES=50`

---

## [Unreleased] — fix/manga-data-completeness

### Fixed
- **mangas** : cartes de recommandations sans année ni note en étoiles. L'app masque volontairement la ligne meta quand année ET note manquent — le problème était côté données API, sur trois causes cumulées, corrigées par ordre de priorité :
  1. **Écrasement par NULL (cause latente, corrigée en premier)** : `getMangaDetails` et `MangaSyncService.syncAllMangasWithApi` faisaient un `SET` **inconditionnel** sur `year` / `rating` / covers depuis `MangaDetailsDto.fromMU`. Quand MU renvoie `bayesian_rating: null` (titre peu voté) ou pas d'année, une valeur correctement remplie par la synchro nocturne était remise à NULL — l'inverse exact de la protection déjà appliquée à l'upsert catalogue. Ces deux chemins passent désormais par `buildProtectedColumnsUpdate` (`manga-completeness.util.ts`) : une colonne protégée absente du payload MU n'entre pas dans le `SET`, une vraie valeur continue d'écraser normalement
  2. **Stubs jamais rattrapés (cause dominante)** : `saveRecommendations` crée des stubs `mu_id + title + covers` (l'endpoint MU « recommendations » ne renvoie NI année NI note) qui restaient à NULL jusqu'au premier clic utilisateur
  3. **Job de rattrapage biaisé (cause aggravante)** : `hydrateMissingGenres` ne sélectionnait que `genres IS NULL` et triait `rating DESC NULLS LAST` — les stubs (rating NULL par construction) passaient systématiquement derrière les ~5000 lignes du catalogue, et une ligne « genres OK / rating NULL » n'était JAMAIS reprise

### Changed
- **mangas** : `hydrateMissingGenres` → `hydrateIncompleteRows` (`catalog-sync.service.ts`) — critère élargi à `genres OR rating OR year OR medium_cover_url IS NULL` ; tri par rating supprimé (il enterrait les lignes à réparer) au profit d'une priorisation par usage réel (`mu_id` présent dans `manga_recommendation` d'abord, via un `EXISTS`), puis `hydration_attempted_at ASC NULLS FIRST`
- **mangas** : garde anti-boucle du job d'hydratation — `manga.hydration_attempted_at` horodatée après CHAQUE tentative (succès **ou** échec), ligne réessayée après 30 jours seulement. Sans elle, les titres pour lesquels MU n'a réellement ni note ni année seraient re-sélectionnés chaque nuit et brûleraient tout le budget en boucle sur les mêmes lignes. Colonne dédiée plutôt que `updated_at < now() - 30 j` : un stub fraîchement créé a un `updated_at` récent et serait exclu 30 jours alors que c'est la ligne à réparer en priorité
- **mangas** : `CATALOG_SYNC_HYDRATION_BUDGET` défaut 200 → **800** (800 × 2 s ≈ 27 min à 30 req/min, moitié du plafond MU anonyme) — avec le critère élargi, 200/nuit mettait plusieurs semaines à rattraper le stock. Documenté dans `template.env` et la spec technique
- **recommendations** : hydratation **à la demande** sur le chemin des recos — `RecommendationService.buildDtoFromScoreMap` et `GenreSectionService.buildSections` repèrent les DTO à `year == 0 || rating == 0` et déclenchent `getMangaDetails` en fire-and-forget (`hydrateIncompleteDtosInBackground`), plafonné à **8 mangas par requête**, jamais bloquant, jamais fatal, `MuRateLimitException` (429) avalée. Résultat visible sous 24 h au lieu de plusieurs nuits — au prochain miss du cache `RecoCacheService` (TTL 1 h), pas sur la requête courante
- **mangas** : `PROTECTED_NULLABLE_COLUMNS` déplacée dans `manga-completeness.util.ts` — source de vérité unique de la doctrine null-safe, partagée par `catalog-sync.mapper.ts`, `getMangaDetails` et `MangaSyncService`
- **mangas** : `MangaSyncService` — `console.error` / `console.log` remplacés par le `Logger` NestJS (règle repo)

### BDD
- Migration `1787875200000-AddHydrationAttemptedAtToManga` : colonne `manga.hydration_attempted_at` (timestamptz nullable) + index `idx_manga_recommendation_recommended_mu_id` (l'index unique existant a `source_mu_id` en tête et ne peut pas servir l'`EXISTS` de priorisation). Additive et idempotente (`hasColumn` / `IF NOT EXISTS`)

### Tests
- +29 tests unitaires (153 → 182) : UPDATE null-safe (MU null → valeur préservée ; MU valeur → écrasement normal ; protection colonne par colonne ; `title`/`completed`/`total_chapters` toujours écrasés), nouvelle sélection d'hydratation (critère élargi, absence de tri par rating, priorisation `manga_recommendation`, fenêtre 30 j, horodatage sur échec, échec d'horodatage non bloquant), hydratation à la demande (plafond 8, dédup, fire-and-forget, échec silencieux, 429 non propagé, rejet synchrone)

---

## [Unreleased] — fix/recos-by-genre-dedup

### Fixed
- **recommendations** : `GET /recommendations/by-genre` — toutes les sections affichaient les mêmes titres (certains en triple) car chaque manga du pool était poussé dans TOUTES les sections de ses genres, sans dédup ni complément. Fix : dédup par `mu_id`, exclusivité inter-sections (un manga n'apparaît que dans la section de son genre le mieux classé — genres favoris de la biblio, fallback représentation pool), complément des sections sous `perGenre` par le catalogue local (rating ≥ 7, NSFW exclus, hors biblio, hors titres déjà affichés — 1 requête max par section, pas de N+1). Logique extraite dans `GenreSectionService` (contrat de réponse `Map<genre, MangaQuickViewDto[]>` inchangé) + 10 tests unitaires dédiés

### Changed (corrections revue adversariale — commit d8641f4)
- **library** : throttle `POST /library/:muId/report-chapters` par userId (10/h) via `UserThrottlerGuard` au lieu du throttle global par IP — le reverse proxy NPMplus masque les IPs clients
- **library** : dédup 10 min `chapter-log` — la fenêtre met désormais à jour `scrollPosition` et `isBonus` de la ligne récente au lieu de l'ignorer silencieusement
- **mangas** : `getRecommendationsForManga` intercepte `MuRateLimitException` (429 MU) et retourne `[]` — dégradation gracieuse, plus de 429 propagé au client
- **mangas** : `buildCatalogUpsertBatches` (`catalog-sync.mapper.ts`) — lots séparés par colonnes non-null ; `rating`, `year`, `covers` jamais écrasés par null
- **mangas** : erreurs DB dans `runCatalogPass` (`catalog-sync.service.ts`) → statut `partial` + `consecutive_failures++` sans sauter la passe (l'ancien comportement ne mettait pas à jour l'état)
- **mangas** : `DescriptionTranslationService` — stale-while-revalidate sur hash mismatch (description MU mise à jour) + negative-cache 5 min sur échec provider

### CI
- Injection optionnelle de `DEEPL_API_KEY` (secret `PROD_DEEPL_API_KEY`) dans le compose NAS via `ci-cd.yml` (commit 1627558)

---

## [Unreleased] — feat/recos-chapitres-traductions

### Added
- **library** : `POST /library/:muId/report-chapters` — signalement « plus de chapitres » par user (Chantier A) : upsert `manga_chapter_report`, total effectif = `max(total officiel, reported_total)`, consolidation communautaire ≥ 2 users distincts (MIN des concordants, écriture GREATEST sur `manga.total_chapters`)
- **mangas** : traductions serveur des descriptions — table `manga_translation` (cache par `(mu_id, language)`, invalidation par `source_hash` sha256), `DescriptionTranslationService` (providers DeepL si `DEEPL_API_KEY` sinon gtx, dédup in-flight, timeout 4 s + upsert en arrière-plan) ; `GET /mangas/:id` lit le header `Accept-Language` et renvoie le champ additif `translated_description` (en = passthrough)
- **mangas** : catalogue local nightly — `@nestjs/schedule`, `CatalogSyncService` (@Cron 03:30 + jitter) pagine les populaires MU (perpage 100, 2 s/appel, backoff 429 5/10/20/40 s, curseur de reprise `catalog_sync_state`, upsert sans écraser les genres, hydratation genres 200/nuit) → ~5000 titres avec genres
- **recommendations** : `CatalogCandidateService` — top-up des candidats par genres favoris depuis le catalogue local quand le pool MU < 150 (rating ≥ 7, NSFW exclus, biblio exclue, score fusionnable)

### Changed
- **recommendations** : fetch à froid — délai 1 s inter-batch + `MuRateLimitException` typée sur 429 (pause 5 s) ; suppression du relax adaptatif (no-op prouvé : `slice(40,80)` sur des tableaux de ~5-25) ; Swagger `limit` max 100 → 500 (aligné `MAX_LIMIT`)
- **library** : `PUT /library/chapter` — cap 406 s'applique au total effectif `max(total_chapters, report user)` et non plus au total officiel seul ; backfill transactionnel du journal `user_manga_chapter_log` (chapitres oldRead+1..newRead, cap 500 derniers, dédup 10 min du chapitre terminal, décrément = no-op) dans la même transaction que le pointeur (fallback séquentiel best-effort)
- **library** : `GET /library/all` — `totalChapters` expose le total effectif + nouveau champ optionnel `userReportedTotalChapters` dans `MangaQuickViewDto`
- **library / mangas** : écriture GREATEST inconditionnelle sur `manga.total_chapters` dans `checkManga` (refresh 6 h) ET `getMangaDetails` (invariant A-5 : monotone croissant, la regex MU sous-estime le vrai total — voir memory-bank/decisions.md)
- **library** : `POST /library/:muId/chapter-log` — fenêtre d'idempotence 10 min : une lecture identique (user, manga, chapitre, non-skippée) < 10 min réutilise la ligne existante

### BDD
- Migration `1753100000000-CreateMangaChapterReport` : nouvelle table `manga_chapter_report` (FK user CASCADE + manga CASCADE, index unique `(user_id, manga_id)`, index `manga_id`)
- Migration `1753200000000-CreateMangaTranslationTable` : nouvelle table `manga_translation` (index unique `(mu_id, language)`)
- Migration `1753300000000-CreateCatalogSyncState` : nouvelle table `catalog_sync_state` (curseur de pagination du cron catalogue)

---

## [Unreleased] — sprint hotfix-v0-10-1

### Added
- `GET /friends/:id/library` : bibliothèque d'un ami — 403 si l'amitié n'est pas acceptée (l'acceptation vaut consentement, RETRO-014) *(sprint social/stats)*
- `GET /user/stats` enrichi Stats v2 : `readingHistory` (20 dernières sessions du journal chapter_log), `chaptersPerWeek` (8 semaines), `genreCounts` (top 10 avec compteurs) — `topGenres` conservé pour compat
- `PUT /user/password` durci : `currentPassword` requis + révocation des sessions après changement *(sprint change-password, en cours de finalisation côté front)*
- `GET /mangas/:muId/cover?mode=stream` : sert les bytes de la cover (cache disque `COVERS_CACHE_DIR`, User-Agent navigateur, fallback 302) — fix CORS Flutter Web
- `RecoCacheService` + `RecoCacheModule` : cache in-memory user-level des recommandations (TTL 1h, MAX_ENTRIES 5000, invalidation sur mutation library) — micro-module autonome sans dépendance externe
- `username.helper.ts` : sanitisation des usernames (pattern, dérivation depuis email, anti-collision, `stripEmailFormat`)
- Volume Docker `manga-tracker-covers` dans le déploiement

### Changed
- `POST /mangas/search` : tri par **pertinence** MangaUpdates (suppression de `orderby: 'rating'` et du re-tri local qui faisaient disparaître les titres de niche, ex. « Shadow System ») ; `perpage` aligné sur `limit` (borné 1-100) ; nouveau param `page` → réponse enveloppe `{results, totalHits, page, perPage, hasMore}` (tableau nu sans `page`, rétrocompat clients ≤ 0.11.0) + 8 tests unitaires `searchManga`
- `JWT_REFRESH_SECRET_EXPIRES_IN` : 7d → 90d en production (standard apps de tracking média)
- `MAX_RECOS_PER_SOURCE` 30 → 40, `ADAPTIVE_FALLBACK_CAP` 60 → 80 (volume de recos insuffisant)
- `RegisterDto.name` : validation stricte (3-32 chars, `@` interdit → exclut le format email)
- Google OAuth : username dérivé du displayName/part locale email (jamais l'email complet), `displayName` rempli
- DTOs publics (comments, friends, public-profile, sharing) : `stripEmailFormat` en defense-in-depth

### Fixed
- 🚨 RGPD : des usernames contenaient l'adresse email de l'utilisateur, exposée publiquement (commentaires, profil, recherche d'amis)
- Logs d'emails retirés (googleStrategy, googleMobileLogin) — règle RGPD projet
- Cycle de modules au bootstrap NestJS : `LibraryModule → RecommendationModule → MangasModule → LibraryModule` cassé via `RecoCacheModule` autonome sans dépendance

### Removed

### BDD
- Migration `SanitizeEmailUsernames` : réécrit les usernames au format email (part locale + suffixe anti-collision, unicité LOWER() RETRO-006) + backfill `displayName` pour tous les comptes
