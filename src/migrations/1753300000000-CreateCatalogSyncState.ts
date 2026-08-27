import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Catalogue local nightly — crée la table `catalog_sync_state` : curseur
 * persistant des passes de synchronisation du catalogue MangaUpdates
 * (CatalogSyncService, cron 03:30).
 *
 * - Une ligne par job (`catalog:rating`, `catalog:week_pos`, `hydration`).
 * - `last_completed_page` permet la reprise après un arrêt partiel
 *   (rate-limit MU, budget de pages épuisé, redémarrage).
 * - Additive et guardée par `hasTable` → sûre avec `migrationsRun` en prod.
 */
export class CreateCatalogSyncState1753300000000 implements MigrationInterface {
  name = 'CreateCatalogSyncState1753300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('catalog_sync_state');
    if (exists) return;

    await queryRunner.createTable(
      new Table({
        name: 'catalog_sync_state',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'job_name',
            type: 'varchar',
            isNullable: false,
            isUnique: true,
          },
          {
            name: 'last_completed_page',
            type: 'int',
            default: 0,
            isNullable: false,
          },
          { name: 'total_pages', type: 'int', isNullable: true },
          { name: 'last_run_at', type: 'timestamptz', isNullable: true },
          { name: 'last_run_status', type: 'varchar', isNullable: true },
          {
            name: 'consecutive_failures',
            type: 'int',
            default: 0,
            isNullable: false,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('catalog_sync_state');
    if (exists) await queryRunner.dropTable('catalog_sync_state');
  }
}
