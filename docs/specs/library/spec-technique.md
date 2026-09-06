# Spec Technique — Library

| Champ         | Valeur                                                        |
|---------------|---------------------------------------------------------------|
| Module        | library                                                       |
| Version       | 0.3.0                                                         |
| Date          | 2026-08-26                                                    |
| Source        | Rétro-ingénierie + Chantier A + fix/recos-by-genre-dedup (corrections revue adversariale) |

## Architecture du module

Le module Library est structuré en trois services distincts montés dans un seul `LibraryModule` :

- **LibraryService** : gère le CRUD de la collection (`UserManga`) — ajout, suppression, mise à jour du compteur de chapitres (avec backfill transactionnel du journal), du statut, du lien personnalisé et de la note. Orchestre également la vérification / création à la volée des entités `Manga` (via `MangasService`). Depuis Chantier A : le cap 406 s'applique au total *effectif* (`max(total_chapters, report user)`).
- **ChapterLogService** : gère le log additif de sessions de lecture (`UserMangaChapterLog`) — insertion de sessions avec déduplication 10 min, liste historique, toggle skip, backfill multi-rows capé à 500 lignes.
- **ChapterReportService** (Chantier A) : gère le signalement « plus de chapitres » (`MangaChapterReport`) — upsert par user, calcul du total effectif, consolidation communautaire (MIN des concordants dès 2 users distincts, écriture GREATEST), purge lazy.

Les routes sont exposées par deux controllers : `LibraryController` (collection + chapter-log) et `ChapterReportController` (sous-controller dédié au signalement, même préfixe `library` — `LibraryController` dépassait déjà la limite de 200 lignes). Toutes les routes sont protégées par `JwtAuthGuard`. L'utilisateur courant est extrait du token via `@UserDecorator()`.

Une dépendance circulaire avec `MangasModule` est résolue par `forwardRef(() => MangasModule)` dans les imports du module.

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/library/library.controller.ts` | Routes HTTP (10 endpoints) | ~254 |
| `src/api/library/chapter-report.controller.ts` | Route HTTP signalement chapitres (Chantier A) | ~73 |
| `src/api/library/library.service.ts` | Logique métier collection (CRUD UserManga, backfill transactionnel) — commentaire race backfill (FOR UPDATE documenté, non implémenté) | ~399 |
| `src/api/library/chapter-log.service.ts` | Log additif de lecture — backfill capé 500, dédup 10 min (mise à jour de la ligne récente : scrollPosition + isBonus) | ~228 |
| `src/api/library/user-throttler.guard.ts` | Guard throttle par userId (10 req/h) sur POST report-chapters — remplace le throttle global par IP (inefficace derrière NPMplus) | ~38 |
| `src/api/library/chapter-report.service.ts` | Signalement chapitres + consolidation communautaire (Chantier A) | ~228 |
| `src/api/library/manga-chapter-report.entity.ts` | Entité TypeORM table `manga_chapter_report` (Chantier A) | ~54 |
| `src/api/library/library.module.ts` | Déclaration du module NestJS | ~26 |
| `src/api/library/reading-status.enum.ts` | Enum ReadingStatus + helpers | ~14 |
| `src/api/library/user-manga-chapter-log.entity.ts` | Entité TypeORM table `user_manga_chapter_log` | ~77 |
| `src/api/mangas/user-manga.entity.ts` | Entité TypeORM table `user_manga` (partagée avec mangas module) | ~43 |
| `src/api/library/dto/save-manga.dto.ts` | DTO ajout / suppression manga | ~9 |
| `src/api/library/dto/update-chapter-dto.ts` | DTO mise à jour compteur chapitres | ~13 |
| `src/api/library/dto/update-reading-status-dto.ts` | DTO mise à jour statut de lecture | ~12 |
| `src/api/library/dto/update-custom-link.dto.ts` | DTO lien personnalisé | ~13 |
| `src/api/library/dto/update-rating.dto.ts` | DTO note personnelle | ~13 |
| `src/api/library/dto/chapter-log.dto.ts` | DTOs log de lecture (RecordChapterLogDto, ToggleChapterSkipDto, ChapterLogEntryDto) | ~80 |
| `src/api/library/dto/report-chapters.dto.ts` | DTOs signalement chapitres (ReportChaptersDto, ReportChaptersResultDto) | ~45 |
| `src/api/library/exceptions/chapter.exception.ts` | Exception HTTP 406 pour chapitre invalide | ~7 |
| `src/api/library/exceptions/reading-status.exception.ts` | Exception HTTP 406 pour statut invalide | ~7 |
| `src/migrations/1753100000000-CreateMangaChapterReport.ts` | Migration création table `manga_chapter_report` | ~88 |

## Schéma BDD

### Table `user_manga`

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | int PK | auto-increment | Identifiant interne |
| `user_id` | int FK | NOT NULL, CASCADE DELETE | Référence `user.id` |
| `manga_id` | varchar FK | NOT NULL, CASCADE DELETE | Référence `manga.mu_id` |
| `adding_date` | timestamp | CreateDate | Date d'ajout à la bibliothèque |
| `user_rating` | int | default 0 | Note personnelle 0-10 (0 = non noté) |
| `user_read_chapters` | int | default 0 | Pointeur de progression (chapitres lus) |
| `readingStatus` | varchar | NOT NULL, default 'readLater' | Statut de lecture (enum) |
| `lastUpdated` | timestamp | nullable, default null | Date de dernière modification |
| `custom_link` | varchar | nullable, default null | Lien de lecture personnalisé |
| `current_chapter` | int | nullable, default null | Chapitre en cours de LECTURE (reprise inter-appareils). NULL = aucune lecture en cours |
| `current_position_percent` | smallint | nullable, default null, CHECK 0-100 | Avancement dans `current_chapter`, en pourcentage |
| `current_position_updated_at` | timestamptz | nullable, default null | Horodatage serveur de la dernière écriture de position acceptée |

Contrainte `chk_user_manga_reading_position` : `current_position_percent` NULL ou dans [0, 100], `current_chapter` NULL ou ≥ 0.
Index `idx_user_manga_manga_id` (`manga_id`) et `idx_user_manga_user_id_manga_id` (`user_id`, `manga_id`).

**Invariant « position vs progression »** : les trois colonnes `current_*` vont toujours ensemble (toutes nulles ou toutes renseignées) et sont **distinctes de `user_read_chapters`** — dernier chapitre TERMINÉ contre endroit où l'on LIT. Dès que `user_read_chapters` atteint ou dépasse `current_chapter`, la position est caduque et repasse à NULL.

### Table `user_manga_chapter_log`

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | int PK | auto-increment | Identifiant interne |
| `user_id` | int FK | NOT NULL, CASCADE DELETE | Référence `user.id` |
| `manga_id` | varchar FK | NOT NULL, CASCADE DELETE | Référence `manga.mu_id` |
| `chapterNumber` | decimal(8,2) | NOT NULL | Numéro de chapitre (décimal pour les 12.5, etc.) |
| `isSkipped` | boolean | default false | Chapitre marqué comme skippé volontairement |
| `isBonus` | boolean | default false | Chapitre bonus / hors-série |
| `scrollPosition` | int | nullable, default null | Position de scroll dans le webview (px) |
| `readAt` | timestamp | CreateDate | Horodatage de la session de lecture |

Index composite : `(user_id, manga_id, chapterNumber)` sur `user_manga_chapter_log`.

### Table `manga_chapter_report` (Chantier A)

| Colonne | Type | Contraintes | Description |
|---------|------|-------------|-------------|
| `id` | int PK | auto-increment | Identifiant interne |
| `user_id` | int FK | NOT NULL, CASCADE DELETE | Référence `user.id` |
| `manga_id` | bigint FK | NOT NULL, CASCADE DELETE | Référence `manga.mu_id` |
| `reported_total` | int | NOT NULL | Total de chapitres signalé par l'user (> total officiel) |
| `created_at` | timestamp | NOT NULL, default CURRENT_TIMESTAMP | Horodatage de création |
| `updated_at` | timestamp | NOT NULL, default CURRENT_TIMESTAMP | Horodatage de dernière modification |

Contrainte d'unicité : `UQ_chapter_report_user_manga (user_id, manga_id)` — un report actif par user et par manga (upsert `ON CONFLICT DO UPDATE`).
Index supplémentaire : `IDX_chapter_report_manga (manga_id)` — couvre la requête de consolidation.

**Invariant** : `reported_total > manga.total_chapters` à l'écriture. Le total effectif pour un user est `max(manga.total_chapters, reported_total)`. Quand le total officiel rattrape ou dépasse le report, la ligne est purgée (purge lazy dans `getEffectiveTotal`).

### Relations

- `UserManga` : ManyToOne vers `User`, ManyToOne vers `Manga` (clé `manga_id` → `manga.mu_id`)
- `UserMangaChapterLog` : ManyToOne vers `User`, ManyToOne vers `Manga` (clé `manga_id` → `manga.mu_id`)
- `MangaChapterReport` : ManyToOne vers `User`, ManyToOne vers `Manga` (clé `manga_id` → `manga.mu_id`, type bigint)
- Les trois tables ont `onDelete: 'CASCADE'` sur les deux FK

## API / Endpoints

| Méthode | Route | Description | Auth | Code retour |
|---------|-------|-------------|------|-------------|
| `POST` | `/library/save` | Ajouter un manga à la bibliothèque | JWT | 200 `MangaDetailsDto` |
| `GET` | `/library/all` | Lister tous les mangas de la bibliothèque | JWT | 200 `MangaQuickViewDto[]` |
| `DELETE` | `/library/delete` | Supprimer un manga de la bibliothèque | JWT | 200 `boolean` |
| `PUT` | `/library/chapter` | Mettre à jour le compteur de chapitres lus | JWT | 200 `UpdateChapterDto` |
| `PUT` | `/library/status` | Forcer le statut de lecture | JWT | 200 `UpdateReadingStatusDto` |
| `PUT` | `/library/custom-link` | Ajouter ou modifier le lien personnalisé | JWT | 200 `boolean` |
| `DELETE` | `/library/custom-link` | Supprimer le lien personnalisé | JWT | 200 `boolean` |
| `PUT` | `/library/rating` | Mettre à jour la note personnelle (0-10) | JWT | 200 `boolean` |
| `POST` | `/library/:muId/chapter-log` | Enregistrer une session de lecture | JWT | 201 `ChapterLogEntryDto` |
| `GET` | `/library/:muId/chapter-log` | Historique des sessions de lecture | JWT | 200 `ChapterLogEntryDto[]` |
| `PUT` | `/library/:muId/chapter/:chapterNumber/skip` | Toggle skip/unskip d'un chapitre | JWT | 200 `ChapterLogEntryDto` |
| `POST` | `/library/:muId/report-chapters` | Signaler un total de chapitres plus élevé que le total officiel (Chantier A) | JWT + `UserThrottlerGuard` 10/h par userId | 201 `ReportChaptersResultDto` |
| `PUT` | `/library/reading-position` | Enregistrer où l'utilisateur en est DANS un chapitre (reprise inter-appareils) | JWT + `ReadingPositionThrottlerGuard` 60/min par userId | 200 `ReadingPositionAckDto` |
| `GET` | `/library/:muId/reading-position` | Position de lecture en cours pour un manga | JWT | 200 `ReadingPositionDto` / **204** si aucune |

### Codes d'erreur spécifiques

| Code | Exception | Déclencheur |
|------|-----------|-------------|
| 400 | `BadRequestException` | Manga déjà présent dans la bibliothèque |
| 400 | `BadRequestException` | `reportedTotal <= total_chapters` (report-chapters : doit être strictement supérieur) |
| 400 | `BadRequestException` | `reportedTotal > total_chapters + 200` (report-chapters : garde-fou anti-typo MAX_REPORT_DELTA) |
| 404 | `NotFoundException` | User, manga introuvable, ou manga absent de la bibliothèque de l'user (report-chapters) |
| 406 | `ChapterException` | `readChapters > effectiveTotal` (total effectif = max(total officiel, report user)) |
| 406 | `ReadingStatusException` | Valeur de statut non reconnue |
| 400 | `ValidationPipe` | `positionPercent` hors de [0, 100] ou `chapter` négatif (reading-position) |
| 409 | `ConflictException` | Doublons `UserManga` en base (anomalie) |

## Enum ReadingStatus

| Valeur | Libellé |
|--------|---------|
| `readLater` | A lire plus tard (statut par défaut à l'ajout) |
| `reading` | En cours de lecture |
| `caughtUp` | A jour (dernier chapitre disponible lu, série en cours) |
| `completed` | Terminé (série complète lue) |

Note : un statut `dropped` (abandonné) est mentionné dans le contexte discovery mais n'est pas présent dans l'enum actuel.

## Patterns identifiés

- **Service layer strict** : `LibraryController` ne contient aucune logique métier — tout est délégué à `LibraryService`, `ChapterLogService` ou `ChapterReportService`.
- **Repository pattern via TypeORM** : les repositories `UserManga`, `User`, `Manga`, `UserMangaChapterLog`, `MangaChapterReport` sont injectés par `@InjectRepository()`.
- **QueryBuilder pour les mises à jour** : les updates (`updateChapter`, `updateReadingStatus`, `consolidate`) utilisent `createQueryBuilder().update()` plutôt que `save()` pour des raisons de performance.
- **Stateless computation du statut** : le statut de lecture est calculé à la volée dans `updateChapter` sans colonne computée en base.
- **Fire-and-forget pour les rafraîchissements** : `checkIfMangaArrayInfoIsOutdated` est appelé sans `await` dans `getMangas`, avec capture des erreurs via `.catch()`.
- **Upsert manuel pour le toggle skip** : `ChapterLogService.toggleSkip` implémente un upsert manuellement (find + update ou create) car TypeORM ne propose pas d'upsert conditionnel natif adapté.
- **Upsert `ON CONFLICT DO UPDATE` pour les reports** : `ChapterReportService.reportMoreChapters` utilise `createQueryBuilder().insert().orUpdate()` sur les colonnes `['reported_total', 'updated_at']` conflitant sur `['user_id', 'manga_id']` (index unique `UQ_chapter_report_user_manga`).
- **Throttle par userId sur report-chapters** : `UserThrottlerGuard` (10 req/h) appliqué sur `POST /library/:muId/report-chapters` à la place du throttle global par IP — nécessaire car l'API est derrière le reverse proxy NPMplus qui masque les IPs clients. Le guard lit `req.user.userId` pour la clé de rate-limit.
- **Race condition backfill documentée** : `LibraryService.persistChapterProgress` contient un commentaire explicitant le risque de race condition sur le backfill transactionnel (deux requêtes simultanées pourraient insérer des doublons dans `user_manga_chapter_log`). Un `SELECT FOR UPDATE` sur la ligne `user_manga` résoudrait le problème mais n'est pas encore implémenté — la fenêtre de dédup 10 min de `ChapterLogService` constitue le filet de sécurité actuel.
- **Création à la volée des entités Manga** : dans `checkManga`, si un manga n'est pas en base, il est créé par appel à l'API MangaUpdates. Ce side-effect est encapsulé dans la méthode privée `checkManga`.
- **`NotFoundInterceptor`** : `POST /library/save` utilise un intercepteur global pour transformer les `NotFoundException` en réponses propres.
- **Deux sources de vérité intentionnellement distinctes** : `user_manga.user_read_chapters` (pointeur de progression) et `user_manga_chapter_log` (historique additif) coexistent sans synchronisation. Le log ne met jamais à jour le compteur — c'est une séparation de responsabilité explicite documentée dans les commentaires du code.
- **GREATEST monotone sur `total_chapters` (invariant A-5)** : tout write sur `manga.total_chapters` — que ce soit dans `checkManga` (refresh MangaUpdates 6 h) ou dans `ChapterReportService.consolidate` (bump communautaire) — utilise `GREATEST(total_chapters, :newTotal)`. La colonne ne régresse jamais. Justification : la regex de parsing du status MangaUpdates sous-estime fréquemment le vrai total ; un total descendant casserait silencieusement la validation cap 406 pour les users ayant déjà progressé.
- **Backfill transactionnel du journal** : `LibraryService.persistChapterProgress` exécute dans une même transaction TypeORM (`dataSource.transaction`, **première utilisation d'`@InjectDataSource` + transaction explicite du repo** — à surveiller au premier déploiement avec `migrationsRun` prod) l'UPDATE du pointeur `user_read_chapters` ET les INSERT multi-rows du backfill `ChapterLogService.recordBackfill`. Fallback séquentiel best-effort si la transaction échoue : UPDATE du pointeur seul (le pointeur prime), puis backfill dans un try/catch `logger.warn`.
- **Consolidation communautaire conservatrice** : `ChapterReportService.consolidate` bumpe `manga.total_chapters` au MIN (pas au MAX) des totaux signalés concordants par ≥ 2 users distincts. Choix conservateur pour limiter l'impact d'un report erroné isolé.

- **Reprise de lecture : état « en cours » sur `user_manga`, PAS dans le journal.** `user_manga_chapter_log.scrollPosition` existait déjà (migration `1746231100000`) mais n'a jamais été alimentée (vérifié en prod le 2026-09-06 : 0 valeur non nulle sur 406 lignes). Elle n'a pas été reprise pour la reprise inter-appareils : `user_manga_chapter_log` est un journal **additif de chapitres TERMINÉS** — plusieurs lignes coexistent pour un même (user, manga, chapitre) (replays, skips, backfill de `PUT /library/chapter`). En tirer « où en est l'utilisateur » imposerait un `DISTINCT ON` sur toute la table à chaque ouverture du lecteur, et le backfill de progression créerait des lignes concurrentes de celles écrites par le lecteur. Un état « en cours » est un **singleton par (user, manga)** : sa place est sur `user_manga`, à côté du pointeur, où il se lit sans jointure dans la requête déjà faite par `GET /library/all`. La colonne du journal reste en place et inchangée.
- **Pourcentage et non pixels** : la hauteur rendue d'un chapitre dépend de l'écran (largeur, densité, zoom, taille du texte) — un offset capturé sur téléphone n'a aucun sens sur tablette. `smallint` 0-100 : 1 % de granularité, très en deçà du seuil perceptible pour une reprise. `ReadingPositionService` arrondit un pourcentage fractionnaire au lieu de le rejeter.
- **Anti-régression sans horloge client** : le contrat `{ muId, chapter, positionPercent }` ne transporte aucun horodatage, le serveur ne peut donc pas comparer deux horloges. Seul signal disponible : la fraîcheur de ce qui est déjà stocké. Tant que la dernière position acceptée a moins de `STALE_WRITE_GRACE_MS`, une position **en retrait sur le même chapitre** est traitée comme le rejeu d'un appareil en retard et ignorée (200 quand même) ; au-delà de la fenêtre elle est acceptée (vraie relecture). Un changement de chapitre passe toujours — navigation délibérée, pas rejeu.
- **Écriture de position jamais bloquante** : hors 400 (bornes du DTO) et 404 (manga hors bibliothèque), un échec BDD est journalisé (`Logger.warn`, sans donnée personnelle) et la route renvoie quand même `{ ok: true }`. C'est de la télémétrie de confort : personne ne doit voir une erreur au milieu d'un chapitre.
- **Invalidation de la position dans le MÊME UPDATE que le pointeur** : `LibraryService.applyChapterPointer` écrit `current_* = CASE WHEN "current_chapter" IS NOT NULL AND :newReadChapters >= "current_chapter" THEN NULL ELSE "current_*" END`. Aucune requête supplémentaire, aucune lecture préalable, pas de N+1 — la condition est évaluée par PostgreSQL sur l'ancienne valeur de la ligne, et l'effet est donc dans la même transaction que le backfill du journal. La condition porte sur la valeur FINALE du pointeur, pas sur le sens de la variation.
- **Throttle nominatif généralisé** : `UserScopedThrottlerGuard` (base abstraite) porte le tracking par `req.user.id` et le remplacement des throttlers injectés ; `UserThrottlerGuard` (report-chapters, 10/h) et `ReadingPositionThrottlerGuard` (reading-position, 60/min) n'en déclarent que le nom, la fenêtre et le quota. `PUT /library/reading-position` porte en plus `@SkipThrottle({ default: true })` : le throttler `default` global compte par IP, ce qui derrière NPMplus serait un budget partagé par tous les lecteurs. Le skip ne vise QUE le throttler nommé `default` — celui du garde s'appelle `reading-position` et reste actif.
- **204 via `@Res({ passthrough: true })`** : Nest pose le statut par défaut (200) AVANT le handler puis, en mode passthrough, appelle `reply(res, body, undefined)` sans le réécrire — le `res.status(204)` du handler fait donc foi et le corps vide part tel quel (vérifié dans `router-execution-context.js` de la version installée).

## Configuration notable

- **Seuil de rafraîchissement des métadonnées** : 6 heures (21 600 000 ms) codé en dur dans `LibraryService.checkManga`.
- **Plafond de pagination du log** : 500 entrées codé en dur dans `ChapterLogService.listForManga` (commentaire "pagination future si besoin").
- **`forwardRef`** : dépendance circulaire entre `LibraryModule` et `MangasModule` résolue par `forwardRef`.
- **`BACKFILL_CAP = 500`** (constante `ChapterLogService`) : au-delà de 500 chapitres de delta en un seul PUT, seuls les 500 derniers sont journalisés. Le pointeur `user_read_chapters`, lui, n'est pas capé.
- **`DEDUP_WINDOW_MINUTES = 10`** (constante `ChapterLogService`) : fenêtre d'idempotence — une lecture non-skippée du même chapitre plus récente que 10 min met à jour la ligne existante (`scrollPosition`, `isBonus`) au lieu d'en créer une nouvelle. Correction adversariale (d8641f4) : l'ancien comportement ignorait silencieusement la mise à jour.
- **`MAX_REPORT_DELTA = 200`** (constante `ChapterReportService`) : garde-fou anti-typo sur les reports — le total signalé ne peut pas dépasser le total officiel + 200.
- **`MIN_REPORTERS = 2`** (constante `ChapterReportService`) : nombre minimum d'utilisateurs distincts concordants pour déclencher une consolidation communautaire du total officiel.
- **`STALE_WRITE_GRACE_MS = 120_000`** (constante `ReadingPositionService`) : fenêtre pendant laquelle une position qui recule sur le même chapitre est considérée comme le rejeu d'un appareil en retard. Auto-résolutive : passé ce délai sans écriture acceptée, un retour en arrière est enregistré normalement.
- **`ReadingPositionThrottlerGuard`** : 60 écritures/min et par utilisateur — deux ordres de grandeur au-dessus de l'usage nominal (le client throttle déjà), assez bas pour couper une boucle de rendu emballée.

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|---------------|--------|
| `src/api/library/chapter-report.service.spec.ts` | Validations 400/404, upsert, consolidation (1 vs 2 users, purge ≤ newTotal), purge lazy `getEffectiveTotal`, batch IN | ✅ |
| `src/api/library/library.service.spec.ts` | `updateChapter` : 406 au-delà du total effectif, statuts Reading/CaughtUp/Completed, backfill transactionnel, décrément no-op, fallback séquentiel ; `checkManga` GREATEST ; `getMangas` exposition reports | ✅ |
| `src/api/library/chapter-log.service.spec.ts` | Fenêtre de dédup 10 min (réutilise / nouvelle ligne), backfill multi-rows, cap 500 (derniers), dédup chapitre terminal, no-op décrément, variante EntityManager | ✅ |
| `src/api/library/reading-position.service.spec.ts` | Écriture nominale, ensemble EXACT des colonnes écrites (`user_read_chapters` jamais touché), 404 hors bibliothèque, arrondi du pourcentage, rejeu ignoré / progression acceptée / retour arrière après la fenêtre, changement de chapitre, échec BDD non bloquant, lecture 204 et ISO 8601, bornes du DTO | ✅ |
| `src/api/library/reading-position.controller.spec.ts` | Passage du corps validé au service, 204 sans corps quand aucune position, 200 avec la position sinon | ✅ |
