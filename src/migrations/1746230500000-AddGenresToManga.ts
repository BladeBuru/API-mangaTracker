import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Ajoute la colonne `genres` (JSON nullable) à la table `manga`.
 * Stocke les genres MangaUpdates pour permettre la segmentation
 * des recommandations par genre.
 *
 * Idempotente : `hasColumn` au début pour ne pas planter si la colonne
 * a déjà été créée par `synchronize: true`.
 */
export class AddGenresToManga1746230500000 implements MigrationInterface {
  name = 'AddGenresToManga1746230500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const has = await queryRunner.hasColumn('manga', 'genres');
    if (has) return;

    await queryRunner.addColumn(
      'manga',
      new TableColumn({
        name: 'genres',
        type: 'json',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const has = await queryRunner.hasColumn('manga', 'genres');
    if (has) {
      await queryRunner.dropColumn('manga', 'genres');
    }
  }
}
