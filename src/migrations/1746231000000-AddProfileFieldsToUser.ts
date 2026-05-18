import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Phase 3 — Profil étendu. Ajoute à `user` :
 * - `avatarUrl` (varchar 512) : URL de l'avatar (proxy interne ou storage NAS).
 * - `displayName` (varchar 80) : nom à afficher publiquement (peut différer du username).
 * - `bio` (varchar 500) : courte description.
 * - `dateOfBirth` (date nullable) : pour stats démographiques (RGPD : opt-in).
 * - `gender` (varchar 32 nullable) : male/female/non_binary/prefer_not_to_say.
 * - `isProfilePublic` (boolean default false) : opt-in pour profil visible par les amis.
 *
 * Toutes les colonnes sont nullables (sauf isProfilePublic = false par défaut)
 * pour ne pas casser les comptes existants. Le flow front décide quand
 * proposer un onboarding démographique optionnel.
 */
export class AddProfileFieldsToUser1746231000000 implements MigrationInterface {
  name = 'AddProfileFieldsToUser1746231000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const cols: TableColumn[] = [
      new TableColumn({
        name: 'avatarUrl',
        type: 'varchar',
        length: '512',
        isNullable: true,
      }),
      new TableColumn({
        name: 'displayName',
        type: 'varchar',
        length: '80',
        isNullable: true,
      }),
      new TableColumn({
        name: 'bio',
        type: 'varchar',
        length: '500',
        isNullable: true,
      }),
      new TableColumn({
        name: 'dateOfBirth',
        type: 'date',
        isNullable: true,
      }),
      new TableColumn({
        name: 'gender',
        type: 'varchar',
        length: '32',
        isNullable: true,
      }),
      new TableColumn({
        name: 'isProfilePublic',
        type: 'boolean',
        isNullable: false,
        default: false,
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
      'avatarUrl',
      'displayName',
      'bio',
      'dateOfBirth',
      'gender',
      'isProfilePublic',
    ]) {
      const has = await queryRunner.hasColumn('user', colName);
      if (has) await queryRunner.dropColumn('user', colName);
    }
  }
}
