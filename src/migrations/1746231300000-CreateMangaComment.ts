import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Phase 7 — Crée `manga_comment` et `comment_report` (skeleton modération).
 *
 * - `manga_comment` : threading via `parent_comment_id`, soft delete,
 *   rating optionnel (review attachée).
 * - `comment_report` : signalements user (un par couple user/comment).
 */
export class CreateMangaComment1746231300000 implements MigrationInterface {
  name = 'CreateMangaComment1746231300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const commentExists = await queryRunner.hasTable('manga_comment');
    if (!commentExists) {
      await queryRunner.createTable(
        new Table({
          name: 'manga_comment',
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
            { name: 'parent_comment_id', type: 'int', isNullable: true },
            { name: 'content', type: 'text', isNullable: false },
            { name: 'rating', type: 'int', isNullable: true },
            {
              name: 'isDeleted',
              type: 'boolean',
              default: false,
              isNullable: false,
            },
            {
              name: 'createdAt',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
              isNullable: false,
            },
            {
              name: 'updatedAt',
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
            {
              columnNames: ['parent_comment_id'],
              referencedTableName: 'manga_comment',
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
            },
          ],
          indices: [
            {
              name: 'IDX_manga_comment_manga_created',
              columnNames: ['manga_id', 'createdAt'],
            },
            {
              name: 'IDX_manga_comment_parent',
              columnNames: ['parent_comment_id'],
            },
          ],
        }),
      );
    }

    const reportExists = await queryRunner.hasTable('comment_report');
    if (!reportExists) {
      await queryRunner.createTable(
        new Table({
          name: 'comment_report',
          columns: [
            {
              name: 'id',
              type: 'int',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            { name: 'user_id', type: 'int', isNullable: false },
            { name: 'comment_id', type: 'int', isNullable: false },
            { name: 'reason', type: 'varchar', length: '64', isNullable: true },
            {
              name: 'createdAt',
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
              columnNames: ['comment_id'],
              referencedTableName: 'manga_comment',
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
            },
          ],
          uniques: [
            {
              name: 'UQ_comment_report_user_comment',
              columnNames: ['user_id', 'comment_id'],
            },
          ],
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const reportExists = await queryRunner.hasTable('comment_report');
    if (reportExists) await queryRunner.dropTable('comment_report');
    const commentExists = await queryRunner.hasTable('manga_comment');
    if (commentExists) await queryRunner.dropTable('manga_comment');
  }
}
