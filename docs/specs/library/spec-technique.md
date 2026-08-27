# Spec Technique — Library

| Champ         | Valeur                            |
|---------------|-----------------------------------|
| Module        | library                           |
| Version       | 0.2.0                             |
| Date          | 2026-07-20                        |
| Source        | Rétro-ingénierie + Chantier A     |

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
| `src/api/library/library.service.ts` | Logique métier collection (CRUD UserManga, backfill transactionnel) | ~399 |
| `src/api/library/chapter-log.service.ts` | Log additif de lecture — backfill capé 500, dédup 10 min | ~228 |
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
| `POST` | `/library/:muId/report-chapters` | Signaler un total de chapitres plus élevé que le total officiel (Chantier A, throttle 10/h) | JWT | 201 `ReportChaptersResultDto` |

### Codes d'erreur spécifiques

| Code | Exception | Déclencheur |
|------|-----------|-------------|
| 400 | `BadRequestException` | Manga déjà présent dans la bibliothèque |
| 400 | `BadRequestException` | `reportedTotal <= total_chapters` (report-chapters : doit être strictement supérieur) |
| 400 | `BadRequestException` | `reportedTotal > total_chapters + 200` (report-chapters : garde-fou anti-typo MAX_REPORT_DELTA) |
| 404 | `NotFoundException` | User, manga introuvable, ou manga absent de la bibliothèque de l'user (report-chapters) |
| 406 | `ChapterException` | `readChapters > effectiveTotal` (total effectif = max(total officiel, report user)) |
| 406 | `ReadingStatusException` | Valeur de statut non reconnue |
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
- **Création à la volée des entités Manga** : dans `checkManga`, si un manga n'est pas en base, il est créé par appel à l'API MangaUpdates. Ce side-effect est encapsulé dans la méthode privée `checkManga`.
- **`NotFoundInterceptor`** : `POST /library/save` utilise un intercepteur global pour transformer les `NotFoundException` en réponses propres.
- **Deux sources de vérité intentionnellement distinctes** : `user_manga.user_read_chapters` (pointeur de progression) et `user_manga_chapter_log` (historique additif) coexistent sans synchronisation. Le log ne met jamais à jour le compteur — c'est une séparation de responsabilité explicite documentée dans les commentaires du code.
- **GREATEST monotone sur `total_chapters` (invariant A-5)** : tout write sur `manga.total_chapters` — que ce soit dans `checkManga` (refresh MangaUpdates 6 h) ou dans `ChapterReportService.consolidate` (bump communautaire) — utilise `GREATEST(total_chapters, :newTotal)`. La colonne ne régresse jamais. Justification : la regex de parsing du status MangaUpdates sous-estime fréquemment le vrai total ; un total descendant casserait silencieusement la validation cap 406 pour les users ayant déjà progressé.
- **Backfill transactionnel du journal** : `LibraryService.persistChapterProgress` exécute dans une même transaction TypeORM (`dataSource.transaction`, **première utilisation d'`@InjectDataSource` + transaction explicite du repo** — à surveiller au premier déploiement avec `migrationsRun` prod) l'UPDATE du pointeur `user_read_chapters` ET les INSERT multi-rows du backfill `ChapterLogService.recordBackfill`. Fallback séquentiel best-effort si la transaction échoue : UPDATE du pointeur seul (le pointeur prime), puis backfill dans un try/catch `logger.warn`.
- **Consolidation communautaire conservatrice** : `ChapterReportService.consolidate` bumpe `manga.total_chapters` au MIN (pas au MAX) des totaux signalés concordants par ≥ 2 users distincts. Choix conservateur pour limiter l'impact d'un report erroné isolé.

## Configuration notable

- **Seuil de rafraîchissement des métadonnées** : 6 heures (21 600 000 ms) codé en dur dans `LibraryService.checkManga`.
- **Plafond de pagination du log** : 500 entrées codé en dur dans `ChapterLogService.listForManga` (commentaire "pagination future si besoin").
- **`forwardRef`** : dépendance circulaire entre `LibraryModule` et `MangasModule` résolue par `forwardRef`.
- **`BACKFILL_CAP = 500`** (constante `ChapterLogService`) : au-delà de 500 chapitres de delta en un seul PUT, seuls les 500 derniers sont journalisés. Le pointeur `user_read_chapters`, lui, n'est pas capé.
- **`DEDUP_WINDOW_MINUTES = 10`** (constante `ChapterLogService`) : fenêtre d'idempotence — une lecture non-skippée du même chapitre plus récente que 10 min n'est pas dupliquée dans le backfill (évite le doublon reader + backfill `updateChapter`).
- **`MAX_REPORT_DELTA = 200`** (constante `ChapterReportService`) : garde-fou anti-typo sur les reports — le total signalé ne peut pas dépasser le total officiel + 200.
- **`MIN_REPORTERS = 2`** (constante `ChapterReportService`) : nombre minimum d'utilisateurs distincts concordants pour déclencher une consolidation communautaire du total officiel.

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|---------------|--------|
| `src/api/library/chapter-report.service.spec.ts` | Validations 400/404, upsert, consolidation (1 vs 2 users, purge ≤ newTotal), purge lazy `getEffectiveTotal`, batch IN | ✅ |
| `src/api/library/library.service.spec.ts` | `updateChapter` : 406 au-delà du total effectif, statuts Reading/CaughtUp/Completed, backfill transactionnel, décrément no-op, fallback séquentiel ; `checkManga` GREATEST ; `getMangas` exposition reports | ✅ |
| `src/api/library/chapter-log.service.spec.ts` | Fenêtre de dédup 10 min (réutilise / nouvelle ligne), backfill multi-rows, cap 500 (derniers), dédup chapitre terminal, no-op décrément, variante EntityManager | ✅ |
