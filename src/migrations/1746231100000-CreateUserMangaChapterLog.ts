import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Phase 5 — Crée la table `user_manga_chapter_log` qui trace chaque session
 * de lecture (additif au pointeur `user_manga.user_read_chapters`).
 *
 * - Plusieurs lignes par (user, manga, chapter) possible → replays.
 * - `is_skipped` : chapitre volontairement ignoré (hors-série filler).
 * - `is_bonus` : chapitre bonus / OAV.
 * - `scroll_position` : reprise de lecture in-app.
 *
 * Le `user_read_chapters` existant reste la source de vérité pour la
 * progression globale. Pas de migration de data — les comptes existants
 * commencent avec un log vide.
 */
export class CreateUserMangaChapterLog1746231100000
  implements MigrationInterface
{
  name = 'CreateUserMangaChapterLog1746231100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('user_manga_chapter_log');
    if (exists) return;

    await queryRunner.createTable(
      new Table({
        name: 'user_manga_chapter_log',
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
          {
            name: 'chapterNumber',
            type: 'decimal',
            precision: 8,
            scale: 2,
            isNullable: false,
          },
          {
            name: 'isSkipped',
            type: 'boolean',
            default: false,
            isNullable: false,
          },
          {
            name: 'isBonus',
            type: 'boolean',
            default: false,
            isNullable: false,
          },
          {
            name: 'scrollPosition',
            type: 'int',
            isNullable: true,
          },
          {
            name: 'readAt',
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
            name: 'IDX_chapter_log_user_manga_chapter',
            columnNames: ['user_id', 'manga_id', 'chapterNumber'],
          },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('user_manga_chapter_log');
    if (exists) await queryRunner.dropTable('user_manga_chapter_log');
  }
}
