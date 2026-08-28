# Schéma BDD — Manga Tracker API

| Champ | Valeur |
|-------|--------|
| SGBD | PostgreSQL 16 |
| ORM | TypeORM 0.3 |
| Dernière MAJ | 2026-08-28 |
| Migration la plus récente | `1787961600000-AddShardingToCatalogSyncState` |

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
| `mangas` | mangas | `Manga` | `1700000000000-InitialSchema`, `1746230500000-AddGenresToManga`, `1746230800000-MakeMangaCoverColumnsNullable`, `1787875200000-AddHydrationAttemptedAtToManga` |
| `user_mangas` | library | `UserManga` | `1700000000000-InitialSchema` |
| `user_manga_chapter_logs` | library | `UserMangaChapterLog` | `1746231100000-CreateUserMangaChapterLog` |
| `manga_chapter_reports` | library | `MangaChapterReport` | `1753100000000-CreateMangaChapterReport` |
| `manga_recommendations` | mangas | `MangaRecommendation` | `1746230400000-CreateMangaRecommendationTable` |
| `manga_translations` | mangas | `MangaTranslation` | `1753200000000-CreateMangaTranslationTable` |
| `catalog_sync_state` | mangas | `CatalogSyncState` | `1753300000000-CreateCatalogSyncState`, `1787961600000-AddShardingToCatalogSyncState` |
| `user_friendships` | friends | `UserFriendship` | `1746231200000-CreateUserFriendship` |
| `manga_comments` | comments | `MangaComment` | `1746231300000-CreateMangaComment` |
| `comment_reports` | comments | `CommentReport` | `1746231300000-CreateMangaComment` |
| `manga_shares` | sharing | `MangaShare` | `1746231400000-CreateSharing` |
| `reading_groups` | sharing | `ReadingGroup` | `1746231400000-CreateSharing` |

---

## Détail des tables modifiées récemment

### Table `catalog_sync_state` (MAJ 2026-08-28)

Une ligne par shard de catalogue. Avant le sharding (v0.2.0), la table contenait
3 lignes fixes (`catalog:rating`, `catalog:week_pos`, `hydration`). Depuis v0.3.0,
elle contient une ligne par shard annuel et ses éventuels sous-shards par genre.

| Colonne | Type PostgreSQL | Contrainte | Notes |
|---------|-----------------|------------|-------|
| `id` | integer | PK, auto-increment | |
| `job_name` | varchar | UNIQUE NOT NULL | Clé du shard. Fixes : `catalog:rating`, `catalog:week_pos`, `hydration`. Dynamiques : `catalog:year:<AAAA>`, `catalog:year:<AAAA>:genre:<Genre>` |
| `last_completed_page` | integer | NOT NULL DEFAULT 0 | Curseur de reprise propre au shard — jamais réinitialisé globalement |
| `total_pages` | integer | nullable | Connu après la 1re réponse MU |
| `last_run_at` | timestamptz | nullable | Horodatage du dernier run, complet ou non |
| `last_run_status` | varchar | nullable | `completed`, `partial`, `failed` |
| `consecutive_failures` | integer | NOT NULL DEFAULT 0 | Remis à 0 sur passe complétée |
| `completed_at` | timestamptz | nullable | **Ajouté par migration 1787961600000.** Date de la dernière complétion intégrale du shard. `NULL` = jamais terminé ou parcours en cours. Pivot de la reprise inter-shards — distinct de `last_run_at` |
| `saturated` | boolean | NOT NULL DEFAULT false | **Ajouté par migration 1787961600000.** `true` quand le shard atteint le plafond `total_hits` MU (10 000) : sous-découpage par genre déclenché |
| `total_hits` | integer | nullable | **Ajouté par migration 1787961600000.** Dernier volume annoncé par MU — diagnostic + détection saturation |
| `created_at` | timestamp | auto | |
| `updated_at` | timestamp | auto | |

**Migration appliquée :** `1787961600000-AddShardingToCatalogSyncState` — additive et idempotente
(`hasColumn` avant chaque `addColumn`). Les lignes existantes reçoivent `completed_at = NULL`
et `saturated = false`, ce qui les rend éligibles au prochain run sans tout recommencer.

**Cardinalité attendue :** ~100 shards annuels (année courante → 1930) + 3 lignes fixes +
sous-shards par genre uniquement si saturation. Ordre de grandeur : 100-200 lignes.

---

## Convention de nommage (rappel)

- Tables : `snake_case` pluriel
- Colonnes : `snake_case`
- PK : `id` (auto-increment integer)
- FK : `<table_singulier>_id`
- Timestamps : `created_at` / `updated_at` (TypeORM `@CreateDateColumn` / `@UpdateDateColumn`)
- Soft delete : `deleted_at` nullable (non utilisé actuellement — suppressions en dur avec cascade)
