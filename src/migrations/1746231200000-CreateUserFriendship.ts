import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Phase 6 — Crée la table `user_friendship` (relations d'amitié).
 *
 * - Status `pending|accepted|blocked`.
 * - Contrainte d'unicité sur (requester, addressee) pour éviter les doublons.
 * - 2 index par statut pour requêter rapidement "mes amis acceptés" /
 *   "mes demandes en attente" sans table scan.
 */
export class CreateUserFriendship1746231200000 implements MigrationInterface {
  name = 'CreateUserFriendship1746231200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('user_friendship');
    if (exists) return;

    await queryRunner.createTable(
      new Table({
        name: 'user_friendship',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'requester_id', type: 'int', isNullable: false },
          { name: 'addressee_id', type: 'int', isNullable: false },
          {
            name: 'status',
            type: 'varchar',
            length: '16',
            default: "'pending'",
            isNullable: false,
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
          {
            name: 'acceptedAt',
            type: 'timestamp',
            isNullable: true,
          },
        ],
        foreignKeys: [
          {
            columnNames: ['requester_id'],
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
        ],
        uniques: [
          {
            name: 'UQ_friendship_requester_addressee',
            columnNames: ['requester_id', 'addressee_id'],
          },
        ],
        indices: [
          {
            name: 'IDX_friendship_addressee_status',
            columnNames: ['addressee_id', 'status'],
          },
          {
            name: 'IDX_friendship_requester_status',
            columnNames: ['requester_id', 'status'],
          },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('user_friendship');
    if (exists) await queryRunner.dropTable('user_friendship');
  }
}
