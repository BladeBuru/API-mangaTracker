import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Crée la table `manga_recommendation` qui stocke le cache des
 * recommandations communautaires extraites de l'API MangaUpdates.
 *
 * Une ligne = "le manga source `source_mu_id` recommande
 * `recommended_mu_id` avec un poids de `weight`".
 *
 * Note : la table peut déjà exister si l'environnement utilise
 * `synchronize: true` (cas dev actuel). Le `IF NOT EXISTS` côté query
 * évite l'erreur. À retirer quand `synchronize: false` sera appliqué.
 */
export class CreateMangaRecommendationTable1746230400000
  implements MigrationInterface
{
  name = 'CreateMangaRecommendationTable1746230400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('manga_recommendation');
    if (exists) return;

    await queryRunner.createTable(
      new Table({
        name: 'manga_recommendation',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'source_mu_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'recommended_mu_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'recommended_title',
            type: 'varchar',
            isNullable: true,
          },
          {
            name: 'weight',
            type: 'int',
            isNullable: false,
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            onUpdate: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'manga_recommendation',
      new TableIndex({
        name: 'IDX_manga_reco_source_recommended_unique',
        columnNames: ['source_mu_id', 'recommended_mu_id'],
        isUnique: true,
      }),
    );

    // Index secondaire pour les requêtes "toutes les recos d'un manga source"
    await queryRunner.createIndex(
      'manga_recommendation',
      new TableIndex({
        name: 'IDX_manga_reco_source',
        columnNames: ['source_mu_id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex(
      'manga_recommendation',
      'IDX_manga_reco_source',
    );
    await queryRunner.dropIndex(
      'manga_recommendation',
      'IDX_manga_reco_source_recommended_unique',
    );
    await queryRunner.dropTable('manga_recommendation', true);
  }
}
