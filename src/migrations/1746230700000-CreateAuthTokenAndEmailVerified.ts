import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

/**
 * Création de la table `auth_token` (tokens single-use signés pour
 * vérification email + reset password) et ajout de `emailVerifiedAt`
 * sur `user`.
 *
 * Idempotente — `hasTable`/`hasColumn` au début pour ne pas planter
 * si `synchronize: true` a déjà créé les structures.
 */
export class CreateAuthTokenAndEmailVerified1746230700000
  implements MigrationInterface
{
  name = 'CreateAuthTokenAndEmailVerified1746230700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. emailVerifiedAt sur User
    const hasEmailVerified = await queryRunner.hasColumn(
      'user',
      'emailVerifiedAt',
    );
    if (!hasEmailVerified) {
      await queryRunner.addColumn(
        'user',
        new TableColumn({
          name: 'emailVerifiedAt',
          type: 'timestamp',
          isNullable: true,
        }),
      );
    }

    // 2. table auth_token
    const hasTable = await queryRunner.hasTable('auth_token');
    if (hasTable) return;

    await queryRunner.createTable(
      new Table({
        name: 'auth_token',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'uuid_generate_v4()',
          },
          { name: 'user_id', type: 'int', isNullable: false },
          {
            name: 'tokenHash',
            type: 'varchar',
            length: '64',
            isNullable: false,
          },
          { name: 'type', type: 'varchar', length: '32', isNullable: false },
          { name: 'expiresAt', type: 'timestamp', isNullable: false },
          { name: 'usedAt', type: 'timestamp', isNullable: true },
          {
            name: 'createdIp',
            type: 'varchar',
            length: '45',
            isNullable: true,
          },
          {
            name: 'createdAt',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    // FK cascade delete (suppression user → suppression de ses tokens)
    await queryRunner.createForeignKey(
      'auth_token',
      new TableForeignKey({
        columnNames: ['user_id'],
        referencedTableName: 'user',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );

    // Lookup en O(1) sur le hash (le token brut hashé en SHA-256 = clé)
    await queryRunner.createIndex(
      'auth_token',
      new TableIndex({
        name: 'IDX_auth_token_hash_unique',
        columnNames: ['tokenHash'],
        isUnique: true,
      }),
    );

    // Lookup pour révoquer en bloc les anciens tokens d'un user/type
    await queryRunner.createIndex(
      'auth_token',
      new TableIndex({
        name: 'IDX_auth_token_user_type',
        columnNames: ['user_id', 'type'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('auth_token')) {
      await queryRunner.dropTable('auth_token', true);
    }
    if (await queryRunner.hasColumn('user', 'emailVerifiedAt')) {
      await queryRunner.dropColumn('user', 'emailVerifiedAt');
    }
  }
}
