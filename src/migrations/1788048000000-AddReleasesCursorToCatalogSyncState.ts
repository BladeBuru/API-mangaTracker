import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Job nocturne des dernières sorties (2026-08-29).
 *
 * 1. `catalog_sync_state.cursor_time_added` (bigint nullable) — curseur
 *    **temporel** du job `releases` : plus grand `time_added.timestamp`
 *    (epoch secondes) déjà traité. Les autres jobs de la table paginent un
 *    catalogue et se repèrent avec `last_completed_page` ; celui-ci consomme
 *    un flux trié par date d'ajout et n'a pas de notion de page à reprendre.
 *
 *    `bigint` et non `int` : un epoch secondes dépasse `int4` en 2038.
 *    Colonne dédiée et non réutilisation de `last_completed_page` : y loger
 *    un horodatage aurait mélangé deux sémantiques dans une colonne dont le
 *    nom promet une page, au détriment de tout diagnostic ultérieur.
 *
 *    `NULL` sur toutes les lignes existantes = « job jamais tourné » → au
 *    premier run, le job se rabat sur une fenêtre de rattrapage bornée
 *    (`RELEASES_SYNC_LOOKBACK_DAYS`, défaut 7 j) au lieu de tenter de remonter
 *    tout l'historique MU.
 *
 * 2. Index `idx_user_manga_manga_id`. L'hydratation priorise désormais les
 *    titres présents dans une bibliothèque utilisateur via un `EXISTS` sur
 *    `user_manga.manga_id` (qui référence `manga.mu_id`). Sans index, ce
 *    critère impose un scan de `user_manga` à chaque sélection du job.
 *
 * Additive et idempotente (`hasColumn` / `IF NOT EXISTS`) → sûre avec
 * `migrationsRun: true` en production.
 */
export class AddReleasesCursorToCatalogSyncState1788048000000
  implements MigrationInterface
{
  name = 'AddReleasesCursorToCatalogSyncState1788048000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasCursor = await queryRunner.hasColumn(
      'catalog_sync_state',
      'cursor_time_added',
    );
    if (!hasCursor) {
      await queryRunner.addColumn(
        'catalog_sync_state',
        new TableColumn({
          name: 'cursor_time_added',
          type: 'bigint',
          isNullable: true,
        }),
      );
    }

    const schema = process.env.DATABASE_SCHEMA ?? 'public';
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_user_manga_manga_id" ` +
        `ON "${schema}"."user_manga" ("manga_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DATABASE_SCHEMA ?? 'public';
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."idx_user_manga_manga_id"`,
    );

    const hasCursor = await queryRunner.hasColumn(
      'catalog_sync_state',
      'cursor_time_added',
    );
    if (hasCursor) {
      await queryRunner.dropColumn('catalog_sync_state', 'cursor_time_added');
    }
  }
}
