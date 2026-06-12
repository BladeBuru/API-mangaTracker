# Spec Fonctionnelle — Library [DRAFT — à valider par le dev]

| Champ      | Valeur              |
|------------|---------------------|
| Module     | library             |
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

| ADR | Titre | Statut |
|-----|-------|--------|
| [RETRO-009](../../adr/RETRO-009-library-dual-read-tracking.md) | Modèle de tracking de lecture dual : pointeur de progression + log additif | Documenté (rétro) |

> *Table auto-générée par adr-linker. Ne pas éditer manuellement.*

---

## Contexte et objectif

Le module Library est le coeur fonctionnel de l'application : il permet à chaque utilisateur de constituer et gérer sa collection personnelle de mangas. Pour chaque manga ajouté, l'utilisateur maintient un état de lecture (statut, chapitres lus, note personnelle, lien de lecture personnalisé). Un log additif secondaire (Phase 5) enrichit la progression brute avec un historique de sessions de lecture chapitre par chapitre, sans remettre en cause le compteur principal.

## Règles métier (déduites du code)

1. **Un manga est unique par utilisateur** : un utilisateur ne peut ajouter deux fois le même manga dans sa bibliothèque (contrôle `ConflictException` sur `(user_id, manga_id)`).

2. **Statut initial à l'ajout** : tout manga nouvellement ajouté reçoit le statut `readLater` par défaut (valeur par défaut dans la colonne `readingStatus` de l'entité `UserManga`).

3. **Mise à jour automatique du statut lors de la progression de lecture** : quand `PUT /library/chapter` est appelé, le statut est recalculé automatiquement :
   - Si `readChapters < total_chapters` → statut forcé à `reading`
   - Si `readChapters == total_chapters` et manga non terminé → statut forcé à `caughtUp`
   - Si `readChapters == total_chapters` et manga terminé (`completed = true`) → statut forcé à `completed`

4. **Le compteur de chapitres ne peut pas dépasser le total** : `readChapters > total_chapters` lève une `ChapterException` (HTTP 406).

5. **Mise à jour manuelle du statut** : `PUT /library/status` permet de forcer un statut indépendamment du compteur. Les valeurs acceptées sont strictement `reading`, `completed`, `caughtUp`, `readLater` (toute autre valeur lève une `ReadingStatusException` HTTP 406). Il n'existe pas de statut `dropped` dans le code actuel (présent dans le contexte discovery mais absent de l'enum).

6. **Rafraîchissement automatique des métadonnées manga** : lors de `PUT /library/chapter`, si les données du manga (MangaUpdates) ont plus de 6 heures ou si `completed` est null, elles sont rechargées depuis l'API MangaUpdates avant la mise à jour du compteur.

7. **Création à la volée d'un manga inconnu** : si le manga référencé par `muId` n'existe pas en base au moment d'un ajout ou d'une mise à jour, il est créé automatiquement par appel à l'API MangaUpdates (via `MangasService`).

8. **Tri de la bibliothèque par date de modification décroissante** : `GET /library/all` retourne les entrées triées par `lastUpdated` DESC.

9. **Mise à jour asynchrone en arrière-plan** : lors de `GET /library/all`, une vérification de fraîcheur des données de tous les mangas de la bibliothèque est déclenchée en arrière-plan (fire-and-forget). Les données fraîches sont visibles à la prochaine requête.

10. **Lien personnalisé** : chaque entrée `UserManga` peut porter un `custom_link` nullable. `PUT /library/custom-link` crée ou remplace ce lien ; `DELETE /library/custom-link` le passe à null.

11. **Note personnelle** : note entière de 0 à 10 (`user_rating`). 0 signifie "pas de note" (valeur par défaut). La mise à jour du rating actualise également `lastUpdated`.

12. **Log additif de chapitres (Phase 5)** : `POST /library/:muId/chapter-log` insère une ligne pour chaque session de lecture (plusieurs lignes possibles pour le même chapitre = replays). Ce log est découplé du compteur `user_read_chapters`. Une ligne peut marquer un chapitre comme bonus (`isBonus = true`) ou skippé (`isSkipped = true`). La position de scroll est optionnellement sauvegardée (`scrollPosition`).

13. **Toggle skip** : `PUT /library/:muId/chapter/:n/skip` opère un upsert : si une ligne `isSkipped` existe déjà pour ce `(user, manga, chapterNumber)`, elle est mise à jour ; sinon une nouvelle ligne est insérée.

14. **Garde-fou pagination log** : `GET /library/:muId/chapter-log` retourne au maximum 500 entrées (tri DESC par `readAt`).

15. **Cascade suppression** : la suppression d'un `UserManga` est opérée via `remove()`. Les `UserMangaChapterLog` liés sont supprimés en cascade au niveau base de données (`onDelete: 'CASCADE'`).

## Cas d'usage (déduits)

### CU-001 — Ajouter un manga à la bibliothèque
Un utilisateur authentifié poste `{ muId }` sur `POST /library/save`. Le système vérifie que le manga n'est pas déjà dans la bibliothèque, récupère ou crée le manga en base (via MangaUpdates si inconnu), crée la relation `UserManga` avec statut `readLater` et retourne le détail complet du manga.

### CU-002 — Consulter sa bibliothèque
`GET /library/all` retourne la liste de tous les mangas de l'utilisateur sous forme de `MangaQuickViewDto[]`, triés par date de dernière modification décroissante. Un processus de mise à jour des métadonnées est lancé en arrière-plan sans bloquer la réponse.

### CU-003 — Supprimer un manga de la bibliothèque
`DELETE /library/delete` avec `{ muId }` supprime l'entrée `UserManga` correspondante. Si aucune entrée n'est trouvée, HTTP 404. Si plusieurs entrées sont trouvées (anomalie de données), HTTP 409.

### CU-004 — Mettre à jour la progression de lecture
`PUT /library/chapter` avec `{ muId, readChapters }` met à jour le compteur et recalcule automatiquement le statut de lecture selon la règle (CU-004 : reading / caughtUp / completed). Retourne le DTO d'entrée en echo.

### CU-005 — Forcer un statut de lecture manuellement
`PUT /library/status` avec `{ muId, readingStatus }` permet de positionner librement le statut, indépendamment du compteur. Valeur invalide → HTTP 406.

### CU-006 — Gérer un lien de lecture personnalisé
`PUT /library/custom-link` associe un lien (URL de lecture externe, par exemple) à un manga de la bibliothèque. `DELETE /library/custom-link` le supprime.

### CU-007 — Noter un manga
`PUT /library/rating` avec `{ muId, rating }` (0 à 10) positionne la note personnelle. 0 équivaut à "pas de note".

### CU-008 — Enregistrer une session de lecture (Phase 5)
`POST /library/:muId/chapter-log` insère une entrée de log pour le chapitre lu, avec possibilité de marquer le chapitre comme bonus et de sauvegarder la position de scroll.

### CU-009 — Consulter l'historique de lecture (Phase 5)
`GET /library/:muId/chapter-log` retourne les 500 dernières entrées de log pour un manga donné, triées par date décroissante.

### CU-010 — Marquer un chapitre comme skippé (Phase 5)
`PUT /library/:muId/chapter/:n/skip` avec `{ skipped: true/false }` bascule le flag skip sur le chapitre sans créer de doublon (upsert sur la ligne skip existante).

## Dépendances

- **MangasModule** (`MangasService`, `UpdateMangaService`) — résolution et rafraîchissement des métadonnées manga depuis MangaUpdates
- **UserService** — vérification de l'existence de l'utilisateur
- **UserManga entity** (`src/api/mangas/user-manga.entity.ts`) — relation centrale entre user et manga
- **Manga entity** (`src/api/mangas/manga.entity.ts`) — métadonnées manga (total chapitres, statut completion)
- **User entity** (`src/api/user/user.entity.ts`) — données utilisateur
- **JwtAuthGuard** — toutes les routes sont protégées par authentification JWT
- **UserDecorator** (`@/shared/Decorator/user.decorator.ts`) — extraction de l'utilisateur depuis le token

## Zones d'incertitude

> Les points suivants n'ont pas pu être déterminés par le code seul :

- **Statut `dropped`** : mentionné dans le contexte discovery mais absent de l'enum `ReadingStatus`. A-t-il été abandonné volontairement ou est-il prévu dans une prochaine itération ?
- **Signification métier de `rating = 0`** : la contrainte `@Min(0)` et `@Max(10)` avec valeur par défaut 0 suggère que 0 = "pas de note", mais il n'y a pas de distinction d'affichage documentée.
- **Politique de suppression du log** : la suppression d'un `UserManga` supprime en cascade les `UserMangaChapterLog`. Y a-t-il un besoin de conserver le log indépendamment du manga dans la bibliothèque ?
- **Pagination du log à long terme** : le plafond de 500 entrées est codé en dur avec un commentaire "pagination future si besoin". La roadmap de cette pagination n'est pas documentée.
- **Sémantique de `scrollPosition`** : la colonne stocke une position en pixels (entier) mais l'unité et l'utilisation côté client ne sont pas documentées.
- **Rafraîchissement à 6 heures** : le seuil `21600000 ms` (6 heures) pour forcer un refresh des métadonnées manga semble arbitraire. Y a-t-il une contrainte business derrière ce délai ?
- **`forwardRef` dans `LibraryModule`** : une dépendance circulaire est résolue via `forwardRef(() => MangasModule)`. La raison exacte de cette circularité n'est pas documentée.
