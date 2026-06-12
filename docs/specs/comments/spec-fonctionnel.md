# Spec Fonctionnelle — Comments [DRAFT — à valider par le dev]

| Champ      | Valeur              |
|------------|---------------------|
| Module     | comments            |
| Version    | 0.1.0               |
| Date       | 2026-06-04          |
| Auteur     | retro-documenter    |
| Statut     | DRAFT               |
| Source     | Rétro-ingénierie    |

> **[DRAFT — à valider par le dev]** Cette spec a été générée par rétro-ingénierie
> à partir du code existant. Elle doit être relue et validée par un développeur
> qui connaît le contexte métier.

---

## ADRs

*Aucun ADR lié.*

> *Table auto-générée par adr-linker. Ne pas éditer manuellement.*

---

## Contexte et objectif

Le module Comments permet aux utilisateurs authentifiés de commenter les fiches manga de la plateforme. Introduit en Phase 7, il couvre la publication de commentaires structurés (avec note optionnelle 1-10), le threading à un niveau de profondeur (un commentaire peut recevoir des réponses directes, une réponse ne peut pas en recevoir à son tour), la suppression douce par l'auteur, et un système de signalement distinct pour alimenter une file de modération future.

## Règles métier (déduites du code)

1. **Authentification obligatoire** : toutes les opérations (lecture, écriture, signalement) requièrent un JWT valide.
2. **Threading limité à 1 niveau** : une réponse (`parentComment != null`) ne peut pas elle-même recevoir de réponses. Ce n'est pas une vérification explicite dans le service, mais la structure de routage ne propose pas d'endpoint `POST /comments/:id/reply` sur une réponse — seul `POST /mangas/:muId/comments` (top-level) et `POST /comments/:id/reply` (réponse à un top-level) existent. En pratique, le code de `createReply` ne vérifie pas que le parent est bien un top-level : c'est un invariant non gardé côté service, à vérifier lors de la validation.
3. **Filtre NSFW à la création et à l'édition** : le contenu est testé contre une regex de mots interdits (`BANNED_WORDS`) avant sauvegarde. Un contenu refusé lève un 400.
4. **Contenu contraint** : longueur de 3 à 2 000 caractères pour tout commentaire ou réponse.
5. **Note optionnelle (review)** : un entier de 1 à 10 peut être attaché à un commentaire top-level ou à une réponse.
6. **Soft delete par l'auteur uniquement** : seul l'auteur peut marquer son commentaire comme supprimé (`isDeleted = true`). L'API masque le contenu (`[supprimé]`) et efface la note dans la réponse, mais conserve la structure en base pour ne pas briser les fils de réponses.
7. **Hard delete réservé aux admins** : prévu mais non implémenté au MVP (TODO dans le code).
8. **Édition par l'auteur uniquement** : un commentaire supprimé ne peut plus être édité ; seul son auteur peut modifier le contenu ou la note.
9. **Signalement unique par user** : un utilisateur ne peut signaler le même commentaire qu'une seule fois (contrainte d'unicité `(user_id, comment_id)` en base). Un double signalement lève un 400.
10. **Signalement avec raison optionnelle** : la raison est un champ libre de 64 caractères maximum, non obligatoire.
11. **Throttle sur les écritures** : création et réponse sont limitées à 10 opérations par heure et par utilisateur (anti-spam), indépendamment du throttler global.
12. **Pagination des commentaires top-level** : page size fixe de 20, avec indicateur `hasMore` calculé par over-fetch (+1).
13. **Tri des commentaires** : deux modes — `recent` (par `createdAt DESC`, défaut) et `top` (par nombre de réponses décroissant, proxy "trending").
14. **Réponses non paginées** : les réponses directes d'un commentaire sont toutes retournées en une seule requête, triées par `createdAt ASC`.
15. **Le manga doit exister** : la création d'un commentaire top-level vérifie que le manga (`mu_id`) est présent en base ; 404 sinon.
16. **Réponse à un commentaire supprimé interdite** : `createReply` vérifie `parent.isDeleted` et lève un 400 si le commentaire parent est supprimé.

## Cas d'usage (déduits)

### CU-001 — Lire les commentaires d'un manga
Un utilisateur authentifié appelle `GET /mangas/:muId/comments?sort=recent&page=1`. Il reçoit la première page de 20 commentaires top-level avec le nombre de réponses de chacun, les infos auteur (username, displayName, avatarUrl), et un flag `hasMore`.

### CU-002 — Poster un commentaire
Un utilisateur authentifié soumet `POST /mangas/:muId/comments` avec un contenu (et éventuellement une note). Si le manga existe et le contenu passe le filtre NSFW, le commentaire est créé et retourné avec replyCount=0.

### CU-003 — Répondre à un commentaire
Un utilisateur authentifié soumet `POST /comments/:commentId/reply`. Le parent doit exister et ne pas être supprimé. La réponse créée est rattachée au même manga que le parent.

### CU-004 — Consulter les réponses d'un commentaire
Un utilisateur authentifié appelle `GET /comments/:commentId/replies`. Toutes les réponses directes sont retournées en ordre chronologique.

### CU-005 — Éditer un commentaire
L'auteur soumet `PATCH /comments/:commentId` avec un nouveau contenu ou une nouvelle note. Le commentaire ne doit pas être supprimé.

### CU-006 — Supprimer son commentaire
L'auteur soumet `DELETE /comments/:commentId`. Le commentaire passe en `isDeleted = true`. L'API retourne `{ deleted: true }`. Le contenu est masqué dans les lectures suivantes mais la ligne reste en base.

### CU-007 — Signaler un commentaire
Un utilisateur authentifié soumet `POST /comments/:commentId/report` avec une raison optionnelle. Si c'est son premier signalement pour ce commentaire, le report est enregistré et `{ reported: true }` est retourné.

## Dépendances

- **Module Manga** (`manga.entity.ts`) : la création d'un commentaire top-level fait un lookup par `mu_id`.
- **Module User** (`user.entity.ts`) : relation `ManyToOne` sur les entités `MangaComment` et `CommentReport` ; les infos auteur (username, displayName, avatarUrl) sont jointes à la lecture.
- **Auth** (`JwtAuthGuard`) : tous les endpoints sont protégés.
- **Throttler global** (`@nestjs/throttler`) : les routes d'écriture ajoutent un throttle spécifique par-dessus le throttler global.

## Zones d'incertitude

> Les points suivants n'ont pas pu être déterminés par le code seul :

- **Invariant 1-niveau non gardé** : `createReply` ne vérifie pas que le parent est un top-level (i.e., `parent.parentComment === null`). Un client qui appelle directement l'endpoint avec l'ID d'une réponse peut créer un commentaire de niveau 2. Est-ce voulu (tolérance) ou un bug à corriger ?
- **Visibilité des commentaires des utilisateurs bloqués** : le code ne filtre pas les commentaires d'utilisateurs avec qui l'appelant est en relation de blocage (feature friends/blocking). Est-ce prévu ou hors scope ?
- **Gestion de modération** : la file d'attente admin sur les reports n'est pas implémentée. Existe-t-il un seuil de reports au-delà duquel un commentaire est automatiquement masqué ? Si oui, ce n'est pas dans le code MVP.
- **Rating sur les réponses** : le DTO `CreateCommentDto` accepte un `rating` sur les réponses comme sur les top-level. Est-ce intentionnel (une réponse peut être une review) ou une omission de validation ?
- **Tri `top` et perf à grande échelle** : le commentaire dans le code signale qu'une colonne cache `reply_count` sera nécessaire si la base grossit. La décision de ne pas la matérialiser pour le MVP est documentée dans `spec-technique.md`.
