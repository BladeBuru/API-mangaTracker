import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Ajoute `manga.type` — le type de publication MangaUpdates (`Manga`,
 * `Manhwa`, `Manhua`, `Novel`, `OEL`…).
 *
 * Constat prod (2026-09-05) : la table `manga` n'avait AUCUNE colonne de
 * type. Le catalogue (≈ 80 000 titres) et les recommandations ne savaient
 * donc pas distinguer un manga japonais d'un manhwa coréen : un utilisateur
 * dont la bibliothèque est presque exclusivement composée de manhwa ne
 * recevait QUE des mangas.
 *
 * - `varchar(32)` nullable, pas d'enum PostgreSQL : convention du repo (cf.
 *   `user_manga.readingStatus`, `user_manga_dismissal.reason`) — une nouvelle
 *   valeur MU ne demande alors aucune migration. NULL = type inconnu (ligne
 *   pas encore revisitée par le catalogue ni par le rattrapage).
 * - `idx_manga_type` : les sections « accueil » par type
 *   (`GET /mangas/home/sections`) et les candidats de recommandation par
 *   type filtrent sur cette colonne.
 * - `idx_manga_year` : les sections par année, les sleepers et le rattrapage
 *   par année (`type:<T>:year:<AAAA>`) filtrent sur `year` — la colonne
 *   n'était pas indexée (seq scan sur 80 000 lignes à chaque requête).
 * - `idx_manga_rating` : toutes les sections « accueil » trient par note
 *   décroissante (`NULLS LAST`) — l'index permet un parcours ordonné borné
 *   par `LIMIT` au lieu d'un top-N heapsort sur toute la table.
 *
 * Additive et idempotente (`hasColumn` / `IF NOT EXISTS`) → sûre avec
 * `migrationsRun: true` en production. Aucune migration de data : le
 * remplissage est assuré par `CatalogTypeBackfillService` (bibliothèques au
 * démarrage, puis job nocturne) et par le catalogue nightly (le payload
 * `/series/search` contient `record.type`).
 */
export class AddTypeToManga1788220800000 implements MigrationInterface {
  name = 'AddTypeToManga1788220800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.hasColumn('manga', 'type');
    if (!hasColumn) {
      await queryRunner.addColumn(
        'manga',
        new TableColumn({
          name: 'type',
          type: 'varchar',
          length: '32',
          isNullable: true,
        }),
      );
    }

    const schema = process.env.DATABASE_SCHEMA ?? 'public';
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_manga_type" ON "${schema}"."manga" ("type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_manga_year" ON "${schema}"."manga" ("year")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_manga_rating" ON "${schema}"."manga" ("rating" DESC NULLS LAST)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DATABASE_SCHEMA ?? 'public';
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."idx_manga_rating"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."idx_manga_year"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."idx_manga_type"`,
    );

    const hasColumn = await queryRunner.hasColumn('manga', 'type');
    if (hasColumn) {
      await queryRunner.dropColumn('manga', 'type');
    }
  }
}
