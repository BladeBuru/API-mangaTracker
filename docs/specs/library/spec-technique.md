# Spec Technique — Library

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | library             |
| Version       | 0.1.0               |
| Date          | 2026-06-04          |
| Source        | Rétro-ingénierie    |

## Architecture du module

Le module Library est structuré en deux services distincts montés dans un seul `LibraryModule` :

- **LibraryService** : gère le CRUD de la collection (`UserManga`) — ajout, suppression, mise à jour du compteur de chapitres, du statut, du lien personnalisé et de la note. Orchestre également la vérification / création à la volée des entités `Manga` (via `MangasService`).
- **ChapterLogService** : gère le log additif de sessions de lecture (`UserMangaChapterLog`) — insertion de sessions, liste historique, toggle skip. Complètement découplé du compteur principal géré par `LibraryService`.

Les deux services sont exposés par un seul `LibraryController`. Toutes les routes sont protégées par `JwtAuthGuard`. L'utilisateur courant est extrait du token via `@UserDecorator()`.

Une dépendance circulaire avec `MangasModule` est résolue par `forwardRef(() => MangasModule)` dans les imports du module.

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/library/library.controller.ts` | Routes HTTP (10 endpoints) | ~252 |
| `src/api/library/library.service.ts` | Logique métier collection (CRUD UserManga, validation) | ~297 |
| `src/api/library/chapter-log.service.ts` | Logique log additif de lecture (Phase 5) | ~115 |
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
| `src/api/library/exceptions/chapter.exception.ts` | Exception HTTP 406 pour chapitre invalide | ~7 |
| `src/api/library/exceptions/reading-status.exception.ts` | Exception HTTP 406 pour statut invalide | ~7 |

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

### Relations

- `UserManga` : ManyToOne vers `User`, ManyToOne vers `Manga` (clé `manga_id` → `manga.mu_id`)
- `UserMangaChapterLog` : ManyToOne vers `User`, ManyToOne vers `Manga` (clé `manga_id` → `manga.mu_id`)
- Les deux tables ont `onDelete: 'CASCADE'` sur les deux FK

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

### Codes d'erreur spécifiques

| Code | Exception | Déclencheur |
|------|-----------|-------------|
| 400 | `BadRequestException` | Manga déjà présent dans la bibliothèque |
| 404 | `NotFoundException` | User ou manga introuvable |
| 406 | `ChapterException` | `readChapters > total_chapters` |
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

- **Service layer strict** : `LibraryController` ne contient aucune logique métier — tout est délégué à `LibraryService` ou `ChapterLogService`.
- **Repository pattern via TypeORM** : les repositories `UserManga`, `User`, `Manga`, `UserMangaChapterLog` sont injectés par `@InjectRepository()`.
- **QueryBuilder pour les mises à jour** : les updates (`updateChapter`, `updateReadingStatus`) utilisent `createQueryBuilder().update()` plutôt que `save()` pour des raisons de performance.
- **Stateless computation du statut** : le statut de lecture est calculé à la volée dans `updateChapter` sans colonne computée en base.
- **Fire-and-forget pour les rafraîchissements** : `checkIfMangaArrayInfoIsOutdated` est appelé sans `await` dans `getMangas`, avec capture des erreurs via `.catch()`.
- **Upsert manuel pour le toggle skip** : `ChapterLogService.toggleSkip` implémente un upsert manuellement (find + update ou create) car TypeORM ne propose pas d'upsert conditionnel natif adapté.
- **Création à la volée des entités Manga** : dans `checkManga`, si un manga n'est pas en base, il est créé par appel à l'API MangaUpdates. Ce side-effect est encapsulé dans la méthode privée `checkManga`.
- **`NotFoundInterceptor`** : `POST /library/save` utilise un intercepteur global pour transformer les `NotFoundException` en réponses propres.
- **Deux sources de vérité intentionnellement distinctes** : `user_manga.user_read_chapters` (pointeur de progression) et `user_manga_chapter_log` (historique additif) coexistent sans synchronisation. Le log ne met jamais à jour le compteur — c'est une séparation de responsabilité explicite documentée dans les commentaires du code.

## Configuration notable

- **Seuil de rafraîchissement des métadonnées** : 6 heures (21 600 000 ms) codé en dur dans `LibraryService.checkManga`.
- **Plafond de pagination du log** : 500 entrées codé en dur dans `ChapterLogService.listForManga` (commentaire "pagination future si besoin").
- **`forwardRef`** : dépendance circulaire entre `LibraryModule` et `MangasModule` résolue par `forwardRef`.

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|---------------|--------|
| *(aucun)* | — | Absent |

Aucun fichier `*.spec.ts` n'a été trouvé dans `src/api/library/`. Le module n'est pas couvert par des tests unitaires automatisés.
