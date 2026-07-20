import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

/**
 * Chantier A (traductions serveur) — Crée la table `manga_translation` :
 * cache des descriptions traduites par (manga, langue).
 *
 * - Unicité (mu_id, language) : une seule traduction par manga et par
 *   langue — l'upsert `ON CONFLICT DO UPDATE` du
 *   `DescriptionTranslationService` s'appuie sur cet index UNIQUE.
 * - `source_hash` (sha256 hex de la description MU) pilote la
 *   re-traduction : hash différent → re-traduire, hash égal → hit.
 * - Pas de FK vers `manga` : le détail est proxifié live depuis MU et le
 *   manga peut ne pas encore exister en base au moment de la traduction
 *   (même choix que `manga_recommendation`).
 *
 * Pas de migration de data — la table démarre vide.
 */
export class CreateMangaTranslationTable1753200000000
  implements MigrationInterface
{
  name = 'CreateMangaTranslationTable1753200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('manga_translation');
    if (exists) return;

    await queryRunner.createTable(
      new Table({
        name: 'manga_translation',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          {
            name: 'mu_id',
            type: 'bigint',
            isNullable: false,
          },
          {
            name: 'language',
            type: 'varchar',
            length: '5',
            isNullable: false,
          },
          {
            name: 'source_hash',
            type: 'varchar',
            length: '64',
            isNullable: false,
          },
          {
            name: 'translated_description',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            onUpdate: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    await queryRunner.createIndex(
      'manga_translation',
      new TableIndex({
        name: 'IDX_manga_translation_mu_lang_unique',
        columnNames: ['mu_id', 'language'],
        isUnique: true,
      }),
    );

    // Index secondaire pour "toutes les traductions d'un manga"
    await queryRunner.createIndex(
      'manga_translation',
      new TableIndex({
        name: 'IDX_manga_translation_mu',
        columnNames: ['mu_id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('manga_translation');
    if (!exists) return;
    await queryRunner.dropIndex(
      'manga_translation',
      'IDX_manga_translation_mu',
    );
    await queryRunner.dropIndex(
      'manga_translation',
      'IDX_manga_translation_mu_lang_unique',
    );
    await queryRunner.dropTable('manga_translation', true);
  }
}
