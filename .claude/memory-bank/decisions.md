# Décisions Architecturales — Manga Tracker API

**Dernière mise à jour :** Septembre 2026

---

## Décisions Prises

### Architecture en couches Controller/Service
**Décision** : Séparation stricte Controller / Service, pas de Repository séparé (TypeORM injecté directement dans les services).
**Raison** : Simplicité pour ce projet de taille moyenne, TypeORM `Repository<Entity>` suffit sans couche supplémentaire.
**Impact** : Controller < 200 lignes, Service < 400 lignes — découpage en services spécialisés si besoin (`SyncMangaService`, `UpdateMangaService`).
**Date** : Conception initiale

---

### Base de données : PostgreSQL + TypeORM
**Décision** : PostgreSQL avec TypeORM (pas Prisma, pas MongoDB).
**Raison** : Données relationnelles (users → library → mangas), besoin de transactions, écosystème NestJS mature.
**Impact** : Entités TypeORM avec décorateurs, migrations TypeORM, UUID pour toutes les PKs.
**Date** : Conception initiale

---

### Authentification : JWT double token (Access + Refresh)
**Décision** : AccessToken court terme + RefreshToken long terme via Passport.
**Raison** : Sécurité (réduire fenêtre d'exposition), expérience utilisateur (pas de re-login fréquent).
**Impact** :
- Endpoint `POST /auth/refresh`
- Stratégies Passport séparées : `jwt` (access) et `jwt-refresh` (refresh)
- Côté Flutter : `HttpService` gère le refresh automatiquement
**Date** : Conception initiale

---

### Source des données mangas : MangaUpdates API
**Décision** : Sync depuis l'API MangaUpdates, pas de scraping.
**Raison** : API officielle, données fiables et structurées.
**Impact** : `SyncMangaService`, `UpdateMangaService`, `MangaEntity` comme cache local.
**Date** : Conception initiale

---

### Validation : class-validator + ValidationPipe (whitelist: true)
**Décision** : Validation stricte avec `whitelist: true` et `forbidNonWhitelisted: true`.
**Raison** : Sécurité (rejet des champs non déclarés), cohérence des données.
**Impact** : Tous les DTOs déclarent explicitement chaque champ autorisé.
**Date** : Conception initiale

---

### Sécurité non-négociable (ajouté évolution)
**Décision** :
- `synchronize: false` en production (jamais auto-sync)
- Migrations TypeORM obligatoires
- Secrets jamais versionnés (`*.env` gitignored, sauf `template.env`)
- `helmet` + `@nestjs/throttler` installés et configurés sur `main.ts`
- CORS avec whitelist explicite par environnement
- Throttle renforcé sur `/auth/login`, `/auth/register`, `/auth/refresh`

**Raison** : Endurcissement avant exposition publique de l'API. L'API sert le mobile (Android, iOS, Web à venir) — surface d'attaque qui s'élargit.
**Impact** : Refactor `main.ts`, ajout dépendances, migrations TypeORM à créer rétroactivement, retrait des secrets versionnés (rotation des clés concernées).
**Date** : 2026-05 (évolution sécurité)

---

### CORS multi-clients (ajouté évolution)
**Décision** : CORS avec whitelist par env, prête pour mobile + web.
**Raison** : Le front Flutter cible Android (actuel), iOS et Web à venir. La whitelist doit anticiper le domaine web futur.
**Impact** : Variable `CORS_ORIGINS` (séparée par virgules) consommée dans `main.ts`. Mise à jour de la whitelist quand le domaine web sera décidé.
**Date** : 2026-05 (évolution sécurité)

---

### total_chapters : écriture GREATEST inconditionnelle (anti-régression)
**Décision** : Toute écriture de `manga.total_chapters` depuis MangaUpdates passe par `GREATEST(total_chapters, :newTotal)` — `MangasService.getMangaDetails`, `LibraryService.checkManga` (refresh 6h) et `ChapterReportService.consolidate` — **y compris quand MU annonce `completed = true` avec un total plus bas**.
**Raison** :
- Le total MU est extrait par regex sur le champ `status` → peu fiable (baisses fantômes constatées).
- `sync-manga.service.ts` faisait déjà `Math.max` : on généralise l'invariant au lieu d'avoir deux comportements.
- Un user avec `user_read_chapters = 90` prouve que le total réel ≥ 90 — une régression re-bloquerait sa progression (bug du cap 406).
- Le chantier « signalement chapitres » (`manga_chapter_report`) repose sur des totaux **monotones croissants** pour que consolidation et refresh 6h convergent sans lock.
**Impact** : une baisse légitime côté MU (correction éditoriale, très rare) ne redescend jamais automatiquement → correction manuelle en BDD assumée. `completed` reste écrasé par MU à chaque refresh (seul `total_chapters` est monotone).
**Date** : 2026-07 (chantiers signalement chapitres + historique de lecture)

---

### `manga.type` : jamais de valeur par défaut, NULL = inconnu
**Décision** : la colonne `manga.type` (Manga / Manhwa / Manhua / Novel / OEL…) n'est jamais remplie par défaut (« Manga ») quand MangaUpdates ne l'a pas encore fournie ; NULL signifie « inconnu » et les recommandations la traitent comme telle (autorisée, pénalisée de moitié si la préférence de l'utilisateur est marquée).
**Raison** : le payload `/series/search` contient `record.type` pour toutes les séries et l'upsert catalogue le persiste : la vraie valeur (y compris `Novel`, `OEL`, `Doujinshi`) arrive au plus tard à la prochaine fenêtre de rafraîchissement du shard annuel (7 j / 30 j). Un défaut fabriquerait une donnée fausse et masquerait une information exploitable. Le rattrapage dédié (`CatalogTypeBackfillService`) n'accélère que ce qui compte pour les utilisateurs : manhwa et manhua.
**Impact** : sections `type:*` de l'accueil possiblement omises quelques semaines ; profil de type ignoré tant que moins de la moitié de la bibliothèque est typée (le volet « bibliothèques au boot » rend ce cas transitoire, ~3 min).
**Date** : 2026-09-05

---

### Recommandations : sélection au prorata du profil de type (pas un simple multiplicateur)
**Décision** : la composition par type des listes de recommandations est garantie par un réordonnancement (`interleaveByTypeMix`, round-robin à déficit) appliqué AVANT la pagination, pas par un facteur sur le score.
**Raison** : un multiplicateur ne garantit aucune proportion (un manga à score 100 bat toujours un manhwa à 25) ; le prorata garantit qu'un lecteur à 80 % manhwa voit ≈ 80 % de manhwa sur CHAQUE page, jamais zéro, et que les pages restent sans trou ni doublon (ordre global déterministe, mis en cache). L'ordre par score est conservé à l'intérieur d'un type.
**Impact** : les candidats catalogue doivent EXISTER par type → requêtes par bucket de type (`fetchByTypeBuckets`) partout où le catalogue est interrogé (`CatalogCandidateService`, compléments de `GenreSectionService`). Constantes : préférence marquée ≥ 60 %, inconnus × 0,5 si marquée, découverte 5 %.
**Date** : 2026-09-05

---

### Un seul job MangaUpdates à la fois (`MuJobLockService`)
**Décision** : tous les jobs qui frappent MU en tâche de fond (rattrapage du type 01:00 et son volet au démarrage, sorties 02:00, catalogue 03:30, hydratation ~04:00, signal de lecture 05:30) passent par un verrou in-process partagé ; un job qui trouve le verrou pris se retire (warn) et reprend à son prochain créneau, ses curseurs étant persistés.
**Raison** : les flags `running` par service n'empêchaient que la réentrance du MÊME job ; un déploiement à 03:35 aurait lancé le rattrapage des bibliothèques pendant la synchro du catalogue — deux appels MU en parallèle, le double du débit convenu (1 req / 2 s). « Ne pas se faire bannir » prime sur la couverture.
**Impact** : in-process (1 seul process API) — remplacer par `pg_advisory_lock` si l'API passe multi-instance, même contrat `tryAcquire`/`release`.
**Suite (2026-09-09)** : le service a été extrait dans `MuJobLockModule`. Tant qu'il était un simple provider de `MangasModule`, tout module qui le re-déclarait en obtenait une SECONDE instance — et le verrou ne verrouillait plus rien. L'arrivée d'un job MU hors de `MangasModule` (`ReaderSignalModule`) rendait ce piège actif : l'instance unique est désormais garantie par construction.
**Date** : 2026-09-05, complétée le 2026-09-09

---

### Accueil : lecture BDD seule, déduplication inter-sections, cache stale-while-revalidate
**Décision** : `GET /mangas/home/sections` ne fait aucun appel MangaUpdates ; l'ordre des sections est fixé côté serveur, un titre n'apparaît que dans la première section qui le sélectionne (pages de détail non dédupliquées), et une réponse périmée (> 10 min) est servie immédiatement puis reconstruite en tâche de fond.
**Raison** : < 300 ms garanti après le premier appel (préchauffé 15 s après le démarrage) ; sans dédup, `popular`, `top_rated`, types et genres affichent les mêmes 20 meilleures notes ; sans lecture progressive, les sections de fin (`hidden_gems`) sont affamées.
**Impact** : le contrat (`id`, `kind`, `params`, `items`) est partagé avec le client Flutter — pas de changement sans bump de version.
**Date** : 2026-09-05

---

### Signal de lecture MangaUpdates : hachage dès l'ingestion, agrégation, purge possible
**Décision** : le signal de lecture public collecté chez MangaUpdates est **pseudonymisé avant toute écriture ET avant toute lecture en base** (HMAC-SHA256 salé, sel en variable d'environnement jamais versionnée) ; aucun champ identifiant n'est persisté ni loggé ; les lignes brutes ne sont qu'un **intermédiaire de calcul** vers des agrégats œuvre↔œuvre qui, eux, ne représentent plus aucun individu ; et la purge des lignes brutes est prévue dès le départ (`READER_SIGNAL_RAW_TTL_DAYS`).
**Raison** : une ligne « tel lecteur a lu telle œuvre » est une donnée personnelle, et une liste de lecture peut révéler indirectement une orientation (une liste majoritairement BL/yaoi, par exemple) — ce qui relève des données sensibles. Le caractère public de la liste ne vaut ni consentement ni base légale. Ajouter la pseudonymisation « après » aurait signifié écrire au moins une fois des identifiants en clair. Le HMAC (et non un SHA-256 nu) est imposé par le fait que les `user_id` MangaUpdates forment un espace énumérable : un hash non salé se casserait par table arc-en-ciel en quelques heures et la pseudonymisation serait cosmétique. Le service est **fail-closed** : sans sel valide, aucun appel réseau n'est fait et rien n'est écrit — un sel par défaut serait pire que rien, il serait dans le dépôt.
**Impact** : les deux étages du job (découverte des lecteurs, extraction de leurs listes) sont **couplés dans un même run**, car l'identifiant MangaUpdates en clair ne vit que dans la mémoire du run — il ne peut donc pas exister de file d'attente de lecteurs reportée au lendemain, et le volume collecté par nuit est borné par ce que la découverte trouve le soir même. Une rotation du sel rend les anciens hash inexploitables (le même lecteur compterait deux fois) : elle impose de purger `reader_signal` et `reader_profile`. La purge est **désactivée par défaut** tant que la pondération peut encore bouger — les agrégats doivent rester recalculables depuis le brut.
**Date** : 2026-09-09

---

### Pondération du signal de lecture : `min(note, type)`, et deux négatifs ne font pas un positif
**Décision** : l'affinité d'une ligne de signal vaut `min(affinité de la note, affinité du type de liste)` — complete +1,00, read +0,60, wish +0,25, hold -0,25, unfinished -0,50 ; et la contribution d'un lecteur à une paire d'œuvres vaut `w(a) × w(b)` **sauf quand les deux affinités sont négatives, où elle vaut 0**.
**Raison** : moduler l'affinité du type par un produit avec la note ferait basculer « abandonné ET mal noté » en signal POSITIF — le contresens exact qu'on cherche à éviter. Le `min` est monotone dans les deux dimensions, laisse une note basse rendre n'importe quelle ligne négative (un `complete` noté 2/10 est un rejet, pas une recommandation) et empêche structurellement une note haute de rendre positif un abandon ou de hisser une simple intention. Côté paires, `(-0,5) × (-0,5) = +0,25` transformerait « ce lecteur a abandonné les deux » en raison de recommander : ce croisement parle de la tolérance du lecteur, pas de la parenté des titres, et le volume d'abandons (~5× moindre que les lectures terminées, mesuré) ne justifie pas d'en tirer une similarité. Le cas MIXTE est en revanche conservé et donne un score négatif — c'est le signal de répulsion qui manque totalement au produit (0 rejet en base).
**Impact** : l'agrégation tourne intégralement en SQL (des millions de paires), la pondération existe donc en deux langages. Elle est **générée** depuis les mêmes constantes TypeScript (`affinitySqlExpression`, `pairContributionSql`), jamais recopiée : une divergence serait invisible et fausserait tous les scores. Toute évolution des poids se fait dans `reader-signal-weights.ts` et impose de relancer l'agrégation complète.
**Date** : 2026-09-09

---

### Collecte du signal : cibler la tête du catalogue, à part égale entre types
**Décision** : la découverte ne parcourt pas les 147 261 séries — elle cible les bibliothèques utilisateurs puis la tête de chaque type d'œuvre (manhwa, manhua, manga) en **round-robin à part égale**, dans la limite d'une profondeur configurable. Le calcul des co-occurrences est restreint au **même périmètre**.
**Raison** : le signal est concentré sur les œuvres populaires. Mesuré le 2026-09-09 sur `/lists/similar/complete` : les têtes de chaque type saturent le plafond MangaUpdates (100 lecteurs) tandis qu'un manhwa tiré au hasard en ramène ~3,5 dont ~2,2 notés — sonder la longue traîne coûterait 5 requêtes par série pour presque rien. Et à note égale, le catalogue est massivement japonais (70 524 manga contre 13 791 manhwa et 11 150 manhua) : un simple `ORDER BY rating` ne produirait quasiment que du manga, c'est-à-dire exactement le biais que le produit cherche à corriger depuis la colonne `manga.type`. Côté agrégation, la même borne est vitale : sans elle l'auto-jointure porterait sur 147 261² paires possibles.
**Impact** : le focus set réel vaut **4 526 œuvres** (1 516 manhwa, 1 504 manhua, 1 503 manga, plus 77 titres de bibliothèque), soit ~10 M de paires possibles. Les recommandations issues de ce chemin ne pourront porter, dans un premier temps, que sur ces œuvres — c'est assumé et cohérent avec la densité mesurée. Élargir se fait en montant `READER_SIGNAL_TYPE_DEPTH`, ce qui élargit **à la fois** la collecte et l'agrégation (une seule variable, pas deux périmètres à garder en phase).
**Biais assumé et documenté** : `/lists/similar` renvoie toujours les **100 `user_id` les plus anciens** d'une série (tri croissant, aucune pagination). Le vivier de lecteurs est donc structurellement biaisé vers les comptes anciens, et re-sonder une cellule déjà vue ne découvre rien de neuf — d'où un curseur qui avance série par série plutôt que de repasser sur les têtes.
**Date** : 2026-09-09

---

## Décisions Futures à Prendre

| Sujet | Contexte | Deadline | Options |
|-------|----------|----------|---------|
| Cache Redis | Réduire les appels MangaUpdates API | v0.2 | Redis + BullMQ vs simple TTL en mémoire |
| Notifications push | Alertes nouvelles sorties | v0.3 | Firebase FCM vs OneSignal vs auto-hébergé |
| Google OAuth2 | Connexion simplifiée | v0.3 | Passport Google vs implémentation manuelle |
| Proxy images | Éviter les restrictions CORS MangaUpdates | Court terme | Endpoint proxy NestJS vs CDN |
| Versioning API | Si rupture de contrat future | v1.0 | Préfixe `/v1/` dès maintenant ou au premier breaking change |
| Rotation secrets JWT | Sécurité long terme | v1.0 | Mécanisme `kid` header vs rotation planifiée |

---

## Alternatives Considérées

| Décision | Alternative rejetée | Raison du rejet |
|----------|-------------------|-----------------|
| TypeORM | Prisma | Écosystème NestJS plus mature avec TypeORM au moment du choix |
| PostgreSQL | MongoDB | Données relationnelles inadaptées à MongoDB |
| JWT maison | Auth0 / Firebase Auth | Complexité inutile pour un projet solo, coût, dépendance externe |
| class-validator | Zod | class-validator natif NestJS, meilleure intégration avec Swagger |
