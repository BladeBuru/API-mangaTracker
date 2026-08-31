import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Complétude des données `manga` (fix 2026-08-28).
 *
 * 1. Ajoute `manga.hydration_attempted_at` (timestamptz nullable) — garde
 *    anti-boucle du job nightly `hydration`
 *    (`CatalogSyncService.hydrateIncompleteRows`). Le job sélectionne
 *    désormais toute ligne incomplète (`genres`, `rating`, `year` ou
 *    `medium_cover_url` NULL) ; sans cette colonne, les titres pour lesquels
 *    MU n'a réellement aucune note ni année seraient re-sélectionnés chaque
 *    nuit et brûleraient tout le budget sur les mêmes lignes. Une ligne
 *    tentée (succès OU échec) est horodatée et n'est réessayée qu'après
 *    30 jours ; NULL = jamais tentée = priorité maximale.
 *
 * 2. Ajoute l'index `idx_manga_recommendation_recommended_mu_id`. La
 *    priorisation du job (« d'abord les lignes réellement vues par les
 *    utilisateurs ») s'appuie sur un `EXISTS` par `recommended_mu_id` ;
 *    l'index unique existant `(source_mu_id, recommended_mu_id)` ne peut pas
 *    le servir, sa colonne de tête étant `source_mu_id`.
 *
 * Additive et idempotente (`hasColumn` / `IF NOT EXISTS`) → sûre avec
 * `migrationsRun: true` en production.
 */
export class AddHydrationAttemptedAtToManga1787875200000
  implements MigrationInterface
{
  name = 'AddHydrationAttemptedAtToManga1787875200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.hasColumn(
      'manga',
      'hydration_attempted_at',
    );
    if (!hasColumn) {
      await queryRunner.addColumn(
        'manga',
        new TableColumn({
          name: 'hydration_attempted_at',
          type: 'timestamptz',
          isNullable: true,
        }),
      );
    }

    const schema = process.env.DATABASE_SCHEMA ?? 'public';
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_manga_recommendation_recommended_mu_id" ` +
        `ON "${schema}"."manga_recommendation" ("recommended_mu_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DATABASE_SCHEMA ?? 'public';
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."idx_manga_recommendation_recommended_mu_id"`,
    );

    const hasColumn = await queryRunner.hasColumn(
      'manga',
      'hydration_attempted_at',
    );
    if (hasColumn) {
      await queryRunner.dropColumn('manga', 'hydration_attempted_at');
    }
  }
}
