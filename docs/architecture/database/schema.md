# Schéma BDD — Manga Tracker API

| Champ | Valeur |
|-------|--------|
| SGBD | PostgreSQL 16 |
| ORM | TypeORM 0.3 |
| Dernière MAJ | 2026-08-29 |
| Migration la plus récente | `1788048000000-AddReleasesCursorToCatalogSyncState` |

> Ce fichier est maintenu par `update-writer-after-implement` après chaque
> migration. Les tables sont groupées par module. Les specs de module contiennent
> des descriptions fonctionnelles plus complètes.

---

## Inventaire des tables

| Table | Module | Entité TypeORM | Migrations clés |
|-------|--------|----------------|-----------------|
| `users` | user | `User` | `1700000000000-InitialSchema`, `1746230600000-AddGdprConsentColumns`, `1746230900000-AddCreatedAtToUser`, `1746231000000-AddProfileFieldsToUser`, `1746231500000-AddUsernameUniqueIndex`, `1746231600000-ChangeAvatarUrlToText` |
| `user_sessions` | auth | `UserSession` | `1700000000000-InitialSchema` |
| `auth_tokens` | auth/email | `AuthToken` | `1746230700000-CreateAuthTokenAndEmailVerified` |
| `mangas` | mangas | `Manga` | `1700000000000-InitialSchema`, `1746230500000-AddGenresToManga`, `1746230800000-MakeMangaCoverColumnsNullable`, `1787875200000-AddHydrationAttemptedAtToManga`, `1788220800000-AddTypeToManga` |
| `user_mangas` | library | `UserManga` | `1700000000000-InitialSchema`, `1788048000000-AddReleasesCursorToCatalogSyncState` (index `manga_id`) |
| `user_manga_chapter_logs` | library | `UserMangaChapterLog` | `1746231100000-CreateUserMangaChapterLog` |
| `manga_chapter_reports` | library | `MangaChapterReport` | `1753100000000-CreateMangaChapterReport` |
| `manga_recommendations` | mangas | `MangaRecommendation` | `1746230400000-CreateMangaRecommendationTable` |
| `manga_translations` | mangas | `MangaTranslation` | `1753200000000-CreateMangaTranslationTable` |
| `catalog_sync_state` | mangas | `CatalogSyncState` | `1753300000000-CreateCatalogSyncState`, `1787961600000-AddShardingToCatalogSyncState`, `1788048000000-AddReleasesCursorToCatalogSyncState` |
| `user_friendships` | friends | `UserFriendship` | `1746231200000-CreateUserFriendship` |
| `manga_comments` | comments | `MangaComment` | `1746231300000-CreateMangaComment` |
| `comment_reports` | comments | `CommentReport` | `1746231300000-CreateMangaComment` |
| `manga_shares` | sharing | `MangaShare` | `1746231400000-CreateSharing` |
| `user_manga_dismissal` | recommendations | `UserMangaDismissal` | `1788048000000-CreateUserMangaDismissal` |
| `reading_groups` | sharing | `ReadingGroup` | `1746231400000-CreateSharing` |

---

## Détail des tables modifiées récemment

### Table `manga` (MAJ 2026-09-05)

| Colonne ajoutée | Type | Contrainte | Notes |
|-----------------|------|-----------|-------|
| `type` | varchar(32) | nullable | Type de publication MangaUpdates (`Manga`, `Manhwa`, `Manhua`, `Novel`, `OEL`, `Doujinshi`…). NULL = inconnu (jamais « pas de type »), **jamais rempli par défaut** — colonne protégée (`PROTECTED_NULLABLE_COLUMNS`) écrite quand MU la fournit, jamais remise à NULL. Alimentée par l'upsert catalogue (`record.type`), `getMangaDetails`, `CatalogTypeBackfillService` |

| Index ajouté | Colonnes | Usage |
|--------------|----------|-------|
| `idx_manga_type` | `(type)` | Sections `type:*` de l'accueil, candidats de recommandation par type |
| `idx_manga_year` | `(year)` | Sections par année, sleepers, rattrapage par année |
| `idx_manga_rating` | `(rating DESC NULLS LAST)` | Tous les tris par note de l'accueil (parcours ordonné borné par `LIMIT`) |

Migration `1788220800000-AddTypeToManga` — additive et idempotente. `catalog_sync_state` reçoit des lignes `type:<T>:year:<AAAA>` (curseurs du rattrapage), sans changement de schéma.

### Table `catalog_sync_state` (MAJ 2026-08-29)

Une ligne par shard de catalogue. Avant le sharding (v0.2.0), la table contenait
3 lignes fixes (`catalog:rating`, `catalog:week_pos`, `hydration`). Depuis v0.3.0,
elle contient une ligne par shard annuel et ses éventuels sous-shards par genre.
S'y ajoute depuis v0.4.0 la ligne fixe `releases` — seul job de la table à ne pas
paginer un catalogue : il consomme un flux trié par date d'ajout et se repère avec
un curseur **temporel** (`cursor_time_added`), pas avec `last_completed_page`.

| Colonne | Type PostgreSQL | Contrainte | Notes |
|---------|-----------------|------------|-------|
| `id` | integer | PK, auto-increment | |
| `job_name` | varchar | UNIQUE NOT NULL | Clé du shard. Fixes : `catalog:rating`, `catalog:week_pos`, `hydration`, `releases`. Dynamiques : `catalog:year:<AAAA>`, `catalog:year:<AAAA>:genre:<Genre>` |
| `last_completed_page` | integer | NOT NULL DEFAULT 0 | Curseur de reprise propre au shard — jamais réinitialisé globalement |
| `total_pages` | integer | nullable | Connu après la 1re réponse MU |
| `last_run_at` | timestamptz | nullable | Horodatage du dernier run, complet ou non |
| `last_run_status` | varchar | nullable | `completed`, `partial`, `failed` |
| `consecutive_failures` | integer | NOT NULL DEFAULT 0 | Remis à 0 sur passe complétée |
| `completed_at` | timestamptz | nullable | **Ajouté par migration 1787961600000.** Date de la dernière complétion intégrale du shard. `NULL` = jamais terminé ou parcours en cours. Pivot de la reprise inter-shards — distinct de `last_run_at` |
| `saturated` | boolean | NOT NULL DEFAULT false | **Ajouté par migration 1787961600000.** `true` quand le shard atteint le plafond `total_hits` MU (10 000) : sous-découpage par genre déclenché |
| `total_hits` | integer | nullable | **Ajouté par migration 1787961600000.** Dernier volume annoncé par MU — diagnostic + détection saturation |
| `cursor_time_added` | bigint | nullable | **Ajouté par migration 1788048000000.** Curseur temporel du job `releases` : plus grand `time_added.timestamp` (epoch secondes) déjà traité. `NULL` sur toute autre ligne, et sur la ligne `releases` tant que le job n'a jamais tourné. `bigint` et non `int` : un epoch secondes dépasse `int4` en 2038 |
| `created_at` | timestamp | auto | |
| `updated_at` | timestamp | auto | |

**Migration appliquée :** `1787961600000-AddShardingToCatalogSyncState` — additive et idempotente
(`hasColumn` avant chaque `addColumn`). Les lignes existantes reçoivent `completed_at = NULL`
et `saturated = false`, ce qui les rend éligibles au prochain run sans tout recommencer.

**Migration appliquée :** `1788048000000-AddReleasesCursorToCatalogSyncState` — ajoute
`cursor_time_added` (bigint nullable) et l'index `idx_user_manga_manga_id`. Additive et
idempotente (`hasColumn` / `IF NOT EXISTS`). `cursor_time_added = NULL` sur les lignes
existantes signifie « job jamais tourné » : au premier run, le job des sorties se limite à
une fenêtre de rattrapage bornée (`RELEASES_SYNC_LOOKBACK_DAYS`, défaut 7 j) au lieu de
tenter de remonter tout l'historique MangaUpdates.

**Index `idx_user_manga_manga_id`** (sur `user_manga.manga_id`, qui référence `manga.mu_id`) :
la priorisation du job d'hydratation s'appuie sur un `EXISTS` par `manga_id` pour remonter
d'abord les titres présents dans une bibliothèque utilisateur. Sans index, ce critère impose
un scan de `user_manga` à chaque sélection.

**Cardinalité attendue :** ~100 shards annuels (année courante → 1930) + 4 lignes fixes +
sous-shards par genre uniquement si saturation. Ordre de grandeur : 100-200 lignes.

---

### Table `user_manga_dismissal` (ajoutée 2026-08-28)

Rejets « pas intéressé / déjà vu » : un titre que l'utilisateur a explicitement
écarté de ses recommandations. Une ligne = un titre écarté par un utilisateur.

| Colonne | Type PostgreSQL | Contrainte | Notes |
|---------|-----------------|------------|-------|
| `id` | integer | PK, auto-increment | |
| `user_id` | integer | FK → `user(id)` ON DELETE CASCADE, NOT NULL | |
| `manga_id` | bigint | FK → `manga(mu_id)` ON DELETE CASCADE, NOT NULL | Même forme de FK que `user_manga` et `manga_chapter_report` (référence `mu_id`, pas `id`) |
| `reason` | varchar(32) | NOT NULL | `already_read` / `not_interested` / `seen_elsewhere` |
| `created_at` | timestamp | NOT NULL DEFAULT CURRENT_TIMESTAMP | |

**Index :**
- `UQ_dismissal_user_manga` UNIQUE `(user_id, manga_id)` — un rejet actif par titre
  et par utilisateur. C'est cette contrainte qui porte l'upsert `ON CONFLICT DO UPDATE`
  du service (pas de `SELECT` préalable, donc pas de fenêtre de course).
- `IDX_dismissal_user` `(user_id)` — chemin chaud : la liste des rejets est lue à
  **chaque** calcul de recommandations (liste plate, sections par genre, sleepers,
  cold start, fiche détail).

**Pourquoi `varchar` et non un enum PostgreSQL :** convention du repo
(cf. `user_manga.readingStatus`), et ajouter une valeur à un enum PG imposerait une
migration alors qu'ici il suffit d'étendre l'enum applicatif validé par `class-validator`.

**Pourquoi une raison typée et obligatoire :** c'est la valeur de la donnée, pas un
détail d'UI. Un booléen « masqué » perdrait la distinction entre « déjà lu, j'ai aimé »
(affinité **positive** mal exploitée) et « pas intéressé » (signal **négatif** réel) —
la base de prod ne contient que 4 notes utilisateur pour 6 comptes, ce sont les seuls
signaux négatifs explicites dont disposera un futur moteur de recommandation.

**Migration appliquée :** `1788048000000-CreateUserMangaDismissal` — création simple,
idempotente (`hasTable`), table vide au départ, aucune migration de data.

**Cardinalité attendue :** quelques dizaines de lignes par utilisateur actif.

> Note de cohérence : l'inventaire ci-dessus liste des noms au pluriel, mais les tables
> réellement créées par les entités et les migrations sont au **singulier**
> (`@Entity('user_manga')`, `@Entity('manga_chapter_report')`, `user_manga_dismissal`).
> La convention de nommage rappelée ci-dessous décrit l'intention, pas l'état du schéma.

---

## Convention de nommage (rappel)

- Tables : `snake_case` pluriel
- Colonnes : `snake_case`
- PK : `id` (auto-increment integer)
- FK : `<table_singulier>_id`
- Timestamps : `created_at` / `updated_at` (TypeORM `@CreateDateColumn` / `@UpdateDateColumn`)
- Soft delete : `deleted_at` nullable (non utilisé actuellement — suppressions en dur avec cascade)
