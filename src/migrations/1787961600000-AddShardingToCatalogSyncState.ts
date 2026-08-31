import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Découpage du catalogue MangaUpdates par année (2026-08-28).
 *
 * `catalog_sync_state` passait de 3 lignes fixes à une ligne par **shard**
 * (`catalog:year:<AAAA>`, `catalog:year:<AAAA>:genre:<Genre>`). Trois colonnes
 * sont nécessaires pour que chaque shard porte sa propre progression :
 *
 * 1. `completed_at` — date de la dernière complétion INTÉGRALE du shard.
 *    Pivot de la reprise inter-shards : le planificateur exclut de la file
 *    les shards terminés depuis moins que leur fenêtre de rafraîchissement,
 *    donc une nuit reprend exactement là où la précédente s'est arrêtée.
 *    `last_run_at` ne peut pas jouer ce rôle : il est horodaté à chaque run,
 *    complet ou non.
 *
 * 2. `saturated` — la requête du shard atteint le plafond `total_hits` de MU
 *    (10 000, mesuré) et sa réponse est donc tronquée. Le planificateur
 *    sous-découpe alors l'année par genre.
 *
 * 3. `total_hits` — dernier volume annoncé par MU, pour le diagnostic et la
 *    détection de saturation.
 *
 * Additive et idempotente (`hasColumn`) → sûre avec `migrationsRun: true` en
 * production. Les 3 lignes existantes reçoivent `completed_at = NULL` et
 * `saturated = false`, ce qui les rend éligibles au prochain run : le
 * comportement au premier démarrage est donc « reprendre le travail », pas
 * « tout recommencer ».
 */
export class AddShardingToCatalogSyncState1787961600000
  implements MigrationInterface
{
  name = 'AddShardingToCatalogSyncState1787961600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasCompletedAt = await queryRunner.hasColumn(
      'catalog_sync_state',
      'completed_at',
    );
    if (!hasCompletedAt) {
      await queryRunner.addColumn(
        'catalog_sync_state',
        new TableColumn({
          name: 'completed_at',
          type: 'timestamptz',
          isNullable: true,
        }),
      );
    }

    const hasSaturated = await queryRunner.hasColumn(
      'catalog_sync_state',
      'saturated',
    );
    if (!hasSaturated) {
      await queryRunner.addColumn(
        'catalog_sync_state',
        new TableColumn({
          name: 'saturated',
          type: 'boolean',
          isNullable: false,
          default: false,
        }),
      );
    }

    const hasTotalHits = await queryRunner.hasColumn(
      'catalog_sync_state',
      'total_hits',
    );
    if (!hasTotalHits) {
      await queryRunner.addColumn(
        'catalog_sync_state',
        new TableColumn({
          name: 'total_hits',
          type: 'int',
          isNullable: true,
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of ['total_hits', 'saturated', 'completed_at']) {
      const hasColumn = await queryRunner.hasColumn(
        'catalog_sync_state',
        column,
      );
      if (hasColumn) {
        await queryRunner.dropColumn('catalog_sync_state', column);
      }
    }
  }
}
