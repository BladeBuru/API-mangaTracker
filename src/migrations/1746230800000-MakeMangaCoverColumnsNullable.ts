import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rend `small_cover_url`, `medium_cover_url`, `rating` et `year` nullable
 * sur la table `manga`.
 *
 * Motivation : permettre l'insertion de "stubs" (lignes manga sans détails
 * complets) lorsqu'on découvre un nouveau manga via `manga_recommendation`.
 * Sans ça, les candidats reco non encore en biblio d'un user sont droppés
 * du résultat (cf. `buildDtoFromScoreMap` qui filtre `mangaMap.get() === null`).
 *
 * Idempotente : on test `is_nullable` avant chaque ALTER pour éviter les
 * runs multiples.
 *
 * NB : on ne touche PAS à `title`, `mu_id`, `total_chapters` qui restent
 * NOT NULL — un stub a forcément `mu_id` et au moins le titre, et
 * `total_chapters` a un DEFAULT 0 donc n'a pas besoin d'être null.
 */
export class MakeMangaCoverColumnsNullable1746230800000
  implements MigrationInterface
{
  name = 'MakeMangaCoverColumnsNullable1746230800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.currentSchema(queryRunner);

    const cols = ['small_cover_url', 'medium_cover_url', 'rating', 'year'];
    for (const col of cols) {
      const isNullable = await this.isNullable(queryRunner, schema, col);
      if (!isNullable) {
        await queryRunner.query(
          `ALTER TABLE "${schema}"."manga" ALTER COLUMN "${col}" DROP NOT NULL`,
        );
      }
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Down est best-effort : si on a inséré des stubs avec NULL, ce SET NOT NULL
    // va échouer. C'est voulu — refaire la migration up est plus sûr que de
    // perdre les stubs en down. Le caller peut purger les stubs avant.
    const schema = await this.currentSchema(queryRunner);
    const cols = ['small_cover_url', 'medium_cover_url', 'rating', 'year'];
    for (const col of cols) {
      const isNullable = await this.isNullable(queryRunner, schema, col);
      if (isNullable) {
        await queryRunner.query(
          `ALTER TABLE "${schema}"."manga" ALTER COLUMN "${col}" SET NOT NULL`,
        );
      }
    }
  }

  /**
   * On lit le schema depuis la config de la connexion plutôt que via
   * `SELECT current_schema()` — ce dernier retourne le premier schema du
   * `search_path` (par défaut `public`), pas celui configuré dans
   * data-source.ts. La précédente version essayait `ALTER TABLE
   * "public"."manga"` et plantait avec `relation "public.manga" does not
   * exist` car nos tables vivent dans `dev`.
   */
  private async currentSchema(queryRunner: QueryRunner): Promise<string> {
    const opts = queryRunner.connection.options as { schema?: string };
    return opts.schema ?? 'public';
  }

  private async isNullable(
    queryRunner: QueryRunner,
    schema: string,
    column: string,
  ): Promise<boolean> {
    const rows: Array<{ is_nullable: string }> = await queryRunner.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'manga' AND column_name = $2`,
      [schema, column],
    );
    return rows[0]?.is_nullable === 'YES';
  }
}
