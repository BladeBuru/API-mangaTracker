import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Chantier A — Crée la table `manga_chapter_report` : signalement par un
 * user que le manga a plus de chapitres que le `manga.total_chapters` connu
 * (la regex sur le status MangaUpdates sous-estime souvent le vrai total).
 *
 * - La ligne est l'override PAR USER : total effectif =
 *   `max(manga.total_chapters, reported_total)`.
 * - Unicité (user_id, manga_id) : un report actif par user et par manga —
 *   un nouveau report écrase l'ancien (upsert `ON CONFLICT DO UPDATE`,
 *   d'où l'index UNIQUE requis sur ces deux colonnes).
 * - Consolidation : ≥ 2 users concordants → bump du total officiel + purge
 *   des reports couverts (voir `ChapterReportService`).
 *
 * Pas de migration de data — la table démarre vide.
 */
export class CreateMangaChapterReport1753100000000
  implements MigrationInterface
{
  name = 'CreateMangaChapterReport1753100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('manga_chapter_report');
    if (exists) return;

    await queryRunner.createTable(
      new Table({
        name: 'manga_chapter_report',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'user_id', type: 'int', isNullable: false },
          { name: 'manga_id', type: 'bigint', isNullable: false },
          { name: 'reported_total', type: 'int', isNullable: false },
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
        foreignKeys: [
          {
            columnNames: ['user_id'],
            referencedTableName: 'user',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
          {
            columnNames: ['manga_id'],
            referencedTableName: 'manga',
            referencedColumnNames: ['mu_id'],
            onDelete: 'CASCADE',
          },
        ],
        indices: [
          {
            name: 'UQ_chapter_report_user_manga',
            columnNames: ['user_id', 'manga_id'],
            isUnique: true,
          },
          {
            name: 'IDX_chapter_report_manga',
            columnNames: ['manga_id'],
          },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('manga_chapter_report');
    if (exists) await queryRunner.dropTable('manga_chapter_report');
  }
}
