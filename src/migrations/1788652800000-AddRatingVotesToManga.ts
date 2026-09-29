import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Ajoute `manga.rating_votes` — le nombre de votants MangaUpdates derrière
 * `manga.rating` (`rating_votes` des payloads `/series/{id}` et
 * `/series/search`).
 *
 * Demande produit (2026-09-30) : afficher une note GLOBALE qui fusionne les
 * votes MangaUpdates et ceux des utilisateurs Manga Tracker, avec le total
 * des votes. Sans le nombre de votants MU, la fusion ne pouvait qu'attribuer
 * un poids arbitraire (50 votants fictifs) à la note MU.
 *
 * - `int` nullable : NULL = inconnu (ligne pas encore revisitée). La fusion
 *   retombe alors sur le poids historique (`rating-aggregator.ts`).
 * - Aucun index : la colonne n'est lue que ligne par ligne (fiche, synthèse
 *   des notes), jamais filtrée ni triée.
 * - Aucune migration de données : le catalogue nocturne et chaque ouverture
 *   de fiche la remplissent (colonne protégée, jamais remise à NULL).
 *
 * Additive et idempotente → sûre avec `migrationsRun: true` en production.
 */
export class AddRatingVotesToManga1788652800000 implements MigrationInterface {
  name = 'AddRatingVotesToManga1788652800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.hasColumn('manga', 'rating_votes');
    if (hasColumn) return;
    await queryRunner.addColumn(
      'manga',
      new TableColumn({
        name: 'rating_votes',
        type: 'int',
        isNullable: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.hasColumn('manga', 'rating_votes');
    if (hasColumn) await queryRunner.dropColumn('manga', 'rating_votes');
  }
}
