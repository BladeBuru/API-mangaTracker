# Spec Technique — Comments

| Champ         | Valeur              |
|---------------|---------------------|
| Module        | comments            |
| Version       | 0.1.0               |
| Date          | 2026-06-04          |
| Source        | Rétro-ingénierie    |

## Architecture du module

Le module `Comments` suit le pattern NestJS Controller / Service / Entity standard. Il expose un `CommentsController` enregistré sous le préfixe `/mangas` (cohérent avec les routes d'écriture) et délègue toute logique au `CommentsService`. Deux entités TypeORM indépendantes coexistent : `MangaComment` (les commentaires et réponses) et `CommentReport` (les signalements, table satellite).

Le service injecte trois repositories TypeORM : `MangaComment`, `CommentReport`, et `Manga` (pour la validation d'existence à la création).

Le `CommentDto` contient une méthode de fabrique statique `fromEntity` qui assure la transformation entity → DTO et le masquage du contenu soft-deleted directement dans la couche de mapping.

## Fichiers impactés

| Fichier | Rôle | Lignes |
|---------|------|--------|
| `src/api/comments/comments.controller.ts` | Routes HTTP, throttle écriture, extraction JWT user | ~120 |
| `src/api/comments/comments.service.ts` | Logique métier : pagination, NSFW, soft delete, report | ~277 |
| `src/api/comments/manga-comment.entity.ts` | Entité `manga_comment` (threading, soft delete, rating) | ~68 |
| `src/api/comments/comment-report.entity.ts` | Entité `comment_report` (signalements, contrainte unicité) | ~43 |
| `src/api/comments/dto/comment.dto.ts` | DTOs Create/Update/List/Report + CommentDto de sortie | ~143 |

## Schéma BDD

### Table `manga_comment`

| Colonne | Type | Contraintes | Notes |
|---------|------|-------------|-------|
| `id` | int | PK auto-increment | |
| `user_id` | int | FK → `user.id`, ON DELETE CASCADE, NOT NULL | |
| `manga_id` | varchar | FK → `manga.mu_id`, ON DELETE CASCADE, NOT NULL | Référence `mu_id`, pas la PK classique |
| `parent_comment_id` | int | FK → `manga_comment.id`, ON DELETE CASCADE, nullable | NULL = top-level |
| `content` | text | NOT NULL | Masqué `[supprimé]` si isDeleted |
| `rating` | int | nullable, default NULL | Entier 1-10, non validé en base |
| `is_deleted` | boolean | default false | Soft delete |
| `created_at` | timestamp | auto | |
| `updated_at` | timestamp | auto | |

Index : `(manga_id, created_at)` — lecture paginée. `(parent_comment_id)` — chargement des réponses et count agrégé.

### Table `comment_report`

| Colonne | Type | Contraintes | Notes |
|---------|------|-------------|-------|
| `id` | int | PK auto-increment | |
| `user_id` | int | FK → `user.id`, ON DELETE CASCADE, NOT NULL | |
| `comment_id` | int | FK → `manga_comment.id`, ON DELETE CASCADE, NOT NULL | |
| `reason` | varchar(64) | nullable | Raison libre |
| `created_at` | timestamp | auto | |

Contrainte d'unicité : `UQ_comment_report_user_comment (user_id, comment_id)`.

## API / Endpoints

| Méthode | Route | Description | Auth | Throttle spécifique |
|---------|-------|-------------|------|---------------------|
| `GET` | `/mangas/:muId/comments` | Liste paginée top-level (sort=recent\|top, page) | JWT | Global |
| `GET` | `/mangas/comments/:commentId/replies` | Toutes les réponses d'un commentaire | JWT | Global |
| `POST` | `/mangas/:muId/comments` | Créer un commentaire top-level | JWT | 10 req/h |
| `POST` | `/mangas/comments/:commentId/reply` | Répondre à un commentaire | JWT | 10 req/h |
| `PATCH` | `/mangas/comments/:commentId` | Éditer son commentaire | JWT | Global |
| `DELETE` | `/mangas/comments/:commentId` | Soft-delete son commentaire | JWT | Global |
| `POST` | `/mangas/comments/:commentId/report` | Signaler un commentaire | JWT | Global |

**Note de routage** : le contrôleur est déclaré `@Controller('mangas')`, ce qui signifie que les routes non paramétrées par `muId` (replies, patch, delete, report) ont le préfixe `/mangas/comments/...` — incohérent visuellement mais fonctionnel.

## Patterns identifiés

- **Soft delete par flag** : `isDeleted` masque le contenu en lecture via `CommentDto.fromEntity` sans supprimer la ligne, préservant l'intégrité des threads de réponses.
- **Over-fetch +1 pour pagination** : `take = PAGE_SIZE + 1`, le résultat `hasMore` est calculé sans COUNT(*) supplémentaire.
- **Reply count par batch** : méthode privée `fetchReplyCounts` (1 requête `GROUP BY`) pour éviter N+1 sur la liste paginée.
- **Tri `top` par sous-requête scalaire** : en l'absence de colonne cache `reply_count`, le tri `top` utilise une sous-requête `COUNT(*)` corrélée. Le commentaire interne signale la limite de passage à l'échelle (colonne cache + trigger à envisager).
- **Filtre NSFW statique** : constante `BANNED_WORDS` (regex `\b(?:nigg|fag|kike|chink)\w*/i`) appliquée à la création et à l'édition. Liste volontairement courte pour MVP — migration vers lib `bad-words` ou service tiers prévue si la base grossit.
- **Cascade DELETE transitive** : suppression d'un utilisateur → cascade sur ses commentaires et ses reports. Suppression d'un manga → cascade sur tous ses commentaires (et leurs reports par cascade imbriquée).
- **Service layer pour le report** : la logique "déjà signalé" est vérifiée applicativement avant INSERT plutôt que de catcher l'exception de contrainte d'unicité (plus lisible, mais race condition potentielle à fort trafic).

## Décisions de design documentées (non promues en ADR)

### Threading 1 niveau — invariant non gardé côté service
La conception du module n'autorise pas les réponses imbriquées, mais cette contrainte est portée uniquement par la structure des endpoints (il n'existe pas de route pour répondre à une réponse) et non par une validation explicite dans `createReply` (absence de vérification `parent.parentComment === null`). Un appel direct à l'endpoint `/reply` avec l'ID d'une réponse crée silencieusement un commentaire de niveau 2.

Ce choix a été évalué pour promotion en ADR DATA-MODEL (invariant de modèle de données). Il a été rejeté à la question Q3 (impact transverse) : la contrainte ne concerne qu'un seul module et n'est pas référencée par d'autres specs. La correction consiste à ajouter une vérification `if (parent.parentComment !== null)` dans `createReply`, sans impact transverse.

### Tri `top` sans colonne cache
Le tri par popularité (`sort=top`) repose sur une sous-requête scalaire à l'exécution. La scalabilité est explicitement signalée comme dette technique dans le code. Ce choix appartient à la catégorie des heuristiques d'implémentation (AP-3) et reste en spec-technique.

### Pagination asymétrique (top-level paginé, réponses non paginées)
`listReplies` retourne toutes les réponses sans pagination. Acceptable pour le MVP (volume de réponses par commentaire généralement faible), mais à reconsidérer si le threading venait à s'approfondir.

## Tests existants

| Fichier | Ce qu'il teste | Statut |
|---------|---------------|--------|
| — | — | Absent |

Aucun fichier `*.spec.ts` n'a été identifié dans le module `comments`.
