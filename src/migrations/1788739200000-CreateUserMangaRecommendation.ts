import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Crée `user_manga_recommendation` — recommandations explicites des
 * utilisateurs Manga Tracker (« si vous avez aimé A, lisez B »).
 *
 * - Une ligne = un vote. Unicité (user_id, source_mu_id, recommended_mu_id) :
 *   recommander deux fois la même paire ne compte qu'une fois.
 * - `IDX_user_reco_source_target` : la fiche d'une œuvre compte les votes de
 *   ses cibles (`WHERE source_mu_id = … GROUP BY recommended_mu_id`).
 * - FK CASCADE sur `user` (suppression de compte, RGPD article 17) et sur
 *   `manga` (source et cible), comme `user_manga_dismissal`.
 * - CHECK source ≠ cible : une œuvre ne se recommande pas elle-même.
 *
 * Table séparée de `manga_recommendation` (graphe MangaUpdates) : cf.
 * l'entité. Additive et idempotente, démarre vide.
 */
export class CreateUserMangaRecommendation1788739200000
  implements MigrationInterface
{
  name = 'CreateUserMangaRecommendation1788739200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('user_manga_recommendation');
    if (exists) return;

    await queryRunner.createTable(
      new Table({
        name: 'user_manga_recommendation',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'user_id', type: 'int', isNullable: false },
          { name: 'source_mu_id', type: 'bigint', isNullable: false },
          { name: 'recommended_mu_id', type: 'bigint', isNullable: false },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
        ],
        foreignKeys: [
          {
            columnNames: ['user_id'],
            referencedTableName: 'user',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
          {
            columnNames: ['source_mu_id'],
            referencedTableName: 'manga',
            referencedColumnNames: ['mu_id'],
            onDelete: 'CASCADE',
          },
          {
            columnNames: ['recommended_mu_id'],
            referencedTableName: 'manga',
            referencedColumnNames: ['mu_id'],
            onDelete: 'CASCADE',
          },
        ],
        indices: [
          {
            name: 'UQ_user_reco_user_source_target',
            columnNames: ['user_id', 'source_mu_id', 'recommended_mu_id'],
            isUnique: true,
          },
          {
            name: 'IDX_user_reco_source_target',
            columnNames: ['source_mu_id', 'recommended_mu_id'],
          },
        ],
        checks: [
          {
            name: 'CHK_user_reco_not_self',
            expression: '"source_mu_id" <> "recommended_mu_id"',
          },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('user_manga_recommendation');
    if (exists) await queryRunner.dropTable('user_manga_recommendation');
  }
}
