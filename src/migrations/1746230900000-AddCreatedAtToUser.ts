import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Ajoute la colonne `createdAt` à `user` pour exposer la date de création
 * du compte dans les statistiques utilisateur (Phase 2 — UserStats).
 *
 * Pour les comptes existants : valeur par défaut = `CURRENT_TIMESTAMP` au
 * moment de la migration. C'est une approximation acceptable pour les
 * stats (le compte existe au moins depuis cette date).
 */
export class AddCreatedAtToUser1746230900000 implements MigrationInterface {
  name = 'AddCreatedAtToUser1746230900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const has = await queryRunner.hasColumn('user', 'createdAt');
    if (!has) {
      await queryRunner.addColumn(
        'user',
        new TableColumn({
          name: 'createdAt',
          type: 'timestamp',
          isNullable: false,
          default: 'CURRENT_TIMESTAMP',
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const has = await queryRunner.hasColumn('user', 'createdAt');
    if (has) await queryRunner.dropColumn('user', 'createdAt');
  }
}
