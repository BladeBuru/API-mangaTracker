import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Collecte anonymisée du signal de lecture public MangaUpdates (2026-09-09).
 *
 * Trois tables, aucune modification de l'existant : la migration est
 * strictement additive et idempotente (`hasTable` avant chaque création,
 * `IF NOT EXISTS` sur chaque index) — sûre avec `migrationsRun: true` en
 * production.
 *
 * ## 1. `reader_signal` — signal brut PSEUDONYMISÉ
 *
 * « Tel lecteur a rangé telle œuvre dans telle liste, avec telle note. »
 * Le lecteur n'y figure QUE par un HMAC-SHA256 salé calculé avant toute
 * écriture (`ReaderHashService`, sel en variable d'environnement, jamais
 * versionné). Ni `user_name`, ni URL de profil, ni titre de série : la
 * colonne `mu_id` suffit, `manga` porte le reste.
 *
 * Pas de clé étrangère vers `manga` alors que `mu_id` la référence : le job
 * n'ingère que des séries déjà connues (filtrage applicatif, même doctrine
 * que `CatalogReleasesService`), mais une purge du catalogue ne doit pas
 * pouvoir supprimer en cascade du signal déjà agrégé.
 *
 * Index :
 * - `UQ_reader_signal_reader_series_type` — unicité métier ET support du
 *   `ON CONFLICT DO UPDATE` qui rend l'ingestion idempotente ;
 * - `IDX_reader_signal_mu_id` — jointure sur le focus set à l'agrégation ;
 * - `IDX_reader_signal_reader` — auto-jointure par lecteur, et purge.
 *
 * ## 2. `reader_profile` — fenêtre de rafraîchissement
 *
 * Empêche de re-collecter chaque nuit les mêmes comptes : `/lists/similar`
 * renvoie toujours les 100 `user_id` les plus anciens d'une série, donc la
 * découverte re-propose massivement des lecteurs déjà vus. Ne contient que
 * le hash et des compteurs.
 *
 * ## 3. `reader_cooccurrence` — agrégats œuvre↔œuvre
 *
 * Le point d'arrivée : plus aucune notion de lecteur, donc plus de données
 * personnelles. C'est ce qui rend possible la purge des lignes brutes une
 * fois les agrégats calculés. Les deux sens de chaque paire sont stockés,
 * pour que le moteur lise `WHERE mu_id_a = ? ORDER BY score DESC` sans `OR`.
 *
 * Les trois tables démarrent vides — aucune migration de données.
 */
export class CreateReaderSignalTables1788566400000
  implements MigrationInterface
{
  name = 'CreateReaderSignalTables1788566400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DATABASE_SCHEMA ?? 'public';

    if (!(await queryRunner.hasTable('reader_signal'))) {
      await queryRunner.createTable(
        new Table({
          name: 'reader_signal',
          columns: [
            {
              name: 'id',
              type: 'bigint',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            // `char(64)` : un SHA-256 hexadécimal fait exactement 64
            // caractères, la longueur fixe évite l'en-tête de longueur d'un
            // varchar sur une table qui comptera des millions de lignes.
            { name: 'user_hash', type: 'char', length: '64' },
            { name: 'mu_id', type: 'bigint' },
            { name: 'list_type', type: 'varchar', length: '16' },
            {
              name: 'rating',
              type: 'numeric',
              precision: 4,
              scale: 2,
              isNullable: true,
            },
            {
              name: 'collected_at',
              type: 'timestamptz',
              default: 'CURRENT_TIMESTAMP',
            },
          ],
        }),
      );
    }
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ` +
        `"UQ_reader_signal_reader_series_type" ON "${schema}"."reader_signal" ` +
        `("user_hash", "mu_id", "list_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_reader_signal_mu_id" ` +
        `ON "${schema}"."reader_signal" ("mu_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_reader_signal_reader" ` +
        `ON "${schema}"."reader_signal" ("user_hash")`,
    );

    if (!(await queryRunner.hasTable('reader_profile'))) {
      await queryRunner.createTable(
        new Table({
          name: 'reader_profile',
          columns: [
            {
              name: 'id',
              type: 'bigint',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            { name: 'user_hash', type: 'char', length: '64', isUnique: true },
            {
              name: 'last_collected_at',
              type: 'timestamptz',
              isNullable: true,
            },
            {
              name: 'status',
              type: 'varchar',
              length: '16',
              isNullable: true,
            },
            { name: 'list_count', type: 'int', default: 0 },
            { name: 'row_count', type: 'int', default: 0 },
            { name: 'failure_count', type: 'int', default: 0 },
            {
              name: 'updated_at',
              type: 'timestamptz',
              default: 'CURRENT_TIMESTAMP',
            },
          ],
        }),
      );
    }
    // L'unicité de `user_hash` porte le `ON CONFLICT (user_hash)` de
    // `recordProfile` : elle doit exister même si la table préexistait.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_reader_profile_hash" ` +
        `ON "${schema}"."reader_profile" ("user_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_reader_profile_last_collected" ` +
        `ON "${schema}"."reader_profile" ("last_collected_at")`,
    );

    if (!(await queryRunner.hasTable('reader_cooccurrence'))) {
      await queryRunner.createTable(
        new Table({
          name: 'reader_cooccurrence',
          columns: [
            {
              name: 'id',
              type: 'bigint',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            { name: 'mu_id_a', type: 'bigint' },
            { name: 'mu_id_b', type: 'bigint' },
            { name: 'co_readers', type: 'int' },
            { name: 'weight', type: 'double precision' },
            { name: 'score', type: 'double precision' },
            {
              name: 'computed_at',
              type: 'timestamptz',
              default: 'CURRENT_TIMESTAMP',
            },
          ],
        }),
      );
    }
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_reader_cooccurrence_pair" ` +
        `ON "${schema}"."reader_cooccurrence" ("mu_id_a", "mu_id_b")`,
    );
    // `score DESC` : c'est l'ordre exact de la lecture du moteur
    // (« meilleures voisines de cette œuvre »).
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_reader_cooccurrence_a_score" ` +
        `ON "${schema}"."reader_cooccurrence" ("mu_id_a", "score" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'reader_cooccurrence',
      'reader_profile',
      'reader_signal',
    ]) {
      if (await queryRunner.hasTable(table)) {
        await queryRunner.dropTable(table);
      }
    }
    // Les curseurs de découverte vivent dans `catalog_sync_state` (lignes
    // `reader-signal:disc:*`) : sans ce nettoyage, un `down` puis un `up`
    // repartirait d'offsets pointant vers un signal qui n'existe plus.
    await queryRunner.query(
      `DELETE FROM catalog_sync_state WHERE job_name LIKE 'reader-signal:%'`,
    );
  }
}
