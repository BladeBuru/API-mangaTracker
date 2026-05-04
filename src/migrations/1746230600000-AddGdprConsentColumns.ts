import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Ajoute les colonnes RGPD à `user` pour tracer le consentement éclairé
 * (CGU + Politique de confidentialité) avec horodatage et version.
 *
 * Ces colonnes sont nullables : les comptes existants à la migration n'ont
 * pas accepté la nouvelle version → ils seront invités à le faire au
 * prochain login (logique applicative).
 */
export class AddGdprConsentColumns1746230600000 implements MigrationInterface {
  name = 'AddGdprConsentColumns1746230600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const cols: TableColumn[] = [
      new TableColumn({
        name: 'acceptedTosAt',
        type: 'timestamp',
        isNullable: true,
      }),
      new TableColumn({
        name: 'acceptedTosVersion',
        type: 'varchar',
        length: '16',
        isNullable: true,
      }),
      new TableColumn({
        name: 'acceptedPrivacyAt',
        type: 'timestamp',
        isNullable: true,
      }),
      new TableColumn({
        name: 'acceptedPrivacyVersion',
        type: 'varchar',
        length: '16',
        isNullable: true,
      }),
    ];

    for (const col of cols) {
      const has = await queryRunner.hasColumn('user', col.name);
      if (!has) {
        await queryRunner.addColumn('user', col);
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const colName of [
      'acceptedTosAt',
      'acceptedTosVersion',
      'acceptedPrivacyAt',
      'acceptedPrivacyVersion',
    ]) {
      const has = await queryRunner.hasColumn('user', colName);
      if (has) await queryRunner.dropColumn('user', colName);
    }
  }
}
