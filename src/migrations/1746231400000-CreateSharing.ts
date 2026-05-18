import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Phase 8 — Crée `manga_share`, `reading_group`, `reading_group_member`.
 *
 * - `manga_share` : event log "user A a partagé manga X avec user B",
 *   avec message optionnel et flag seen.
 * - `reading_group` + `reading_group_member` : skeleton lecture à deux.
 *   La sync de progression utilise les endpoints existants côté client
 *   (polling 30s), pas de mécanisme dédié pour MVP.
 */
export class CreateSharing1746231400000 implements MigrationInterface {
  name = 'CreateSharing1746231400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('manga_share'))) {
      await queryRunner.createTable(
        new Table({
          name: 'manga_share',
          columns: [
            {
              name: 'id',
              type: 'int',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            { name: 'sender_id', type: 'int', isNullable: false },
            { name: 'addressee_id', type: 'int', isNullable: false },
            { name: 'manga_id', type: 'bigint', isNullable: false },
            { name: 'message', type: 'varchar', length: '280', isNullable: true },
            {
              name: 'createdAt',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
              isNullable: false,
            },
            { name: 'seenAt', type: 'timestamp', isNullable: true },
          ],
          foreignKeys: [
            {
              columnNames: ['sender_id'],
              referencedTableName: 'user',
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
            },
            {
              columnNames: ['addressee_id'],
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
              name: 'IDX_manga_share_addressee_seen',
              columnNames: ['addressee_id', 'seenAt'],
            },
          ],
        }),
      );
    }

    if (!(await queryRunner.hasTable('reading_group'))) {
      await queryRunner.createTable(
        new Table({
          name: 'reading_group',
          columns: [
            {
              name: 'id',
              type: 'int',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            { name: 'owner_id', type: 'int', isNullable: false },
            { name: 'manga_id', type: 'bigint', isNullable: false },
            { name: 'name', type: 'varchar', length: '80', isNullable: true },
            {
              name: 'createdAt',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
              isNullable: false,
            },
          ],
          foreignKeys: [
            {
              columnNames: ['owner_id'],
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
        }),
      );
    }

    if (!(await queryRunner.hasTable('reading_group_member'))) {
      await queryRunner.createTable(
        new Table({
          name: 'reading_group_member',
          columns: [
            {
              name: 'id',
              type: 'int',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            { name: 'group_id', type: 'int', isNullable: false },
            { name: 'user_id', type: 'int', isNullable: false },
            {
              name: 'joinedAt',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
              isNullable: false,
            },
          ],
          foreignKeys: [
            {
              columnNames: ['group_id'],
              referencedTableName: 'reading_group',
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
            },
            {
              columnNames: ['user_id'],
              referencedTableName: 'user',
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
            },
          ],
          uniques: [
            {
              name: 'UQ_reading_group_member_group_user',
              columnNames: ['group_id', 'user_id'],
            },
          ],
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('reading_group_member')) {
      await queryRunner.dropTable('reading_group_member');
    }
    if (await queryRunner.hasTable('reading_group')) {
      await queryRunner.dropTable('reading_group');
    }
    if (await queryRunner.hasTable('manga_share')) {
      await queryRunner.dropTable('manga_share');
    }
  }
}
