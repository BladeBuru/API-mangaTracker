import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Reprise de lecture inter-appareils — ajoute l'état « lecture EN COURS »
 * sur `user_manga`.
 *
 * Constat prod (2026-09-06) : la position DANS un chapitre n'existait que
 * dans les `SharedPreferences` de l'appareil (clé `scroll_position_<muId>_<n>`).
 * On passe du téléphone à la tablette → on repart au début du chapitre.
 *
 * ## Pourquoi PAS `user_manga_chapter_log.scrollPosition`
 *
 * La colonne existe déjà mais elle est vide en production (0 ligne non nulle
 * sur 406). Surtout, `user_manga_chapter_log` est un journal **additif de
 * chapitres TERMINÉS** : plusieurs lignes par (user, manga, chapitre) —
 * replays, skips, backfill de `PUT /library/chapter`. Y chercher « où en
 * est l'utilisateur » supposerait un `DISTINCT ON` sur toute la table à
 * chaque ouverture du lecteur, et le backfill de la progression créerait des
 * lignes concurrentes de celle du lecteur. Un état « en cours » est un
 * SINGLETON par (user, manga) : sa place est sur `user_manga`, à côté du
 * pointeur `user_read_chapters`, où il se lit sans jointure dans la requête
 * déjà faite par `GET /library/all`.
 *
 * ## Pourquoi un POURCENTAGE et pas des pixels
 *
 * La hauteur rendue d'un chapitre dépend de l'appareil (largeur d'écran,
 * densité, zoom, taille du texte). Un offset en pixels capturé sur téléphone
 * ne veut rien dire sur tablette. Seul un ratio 0-100 est transportable —
 * d'où `smallint` (1 % de granularité, très en deçà du seuil perceptible
 * pour une reprise) plutôt qu'un `integer` de pixels.
 *
 * ## Colonnes
 *
 * - `current_chapter` (int, nullable) — chapitre en cours de lecture. NULL =
 *   aucune lecture en cours (ou position devenue caduque, cf. ci-dessous).
 *   Distinct de `user_read_chapters` (dernier chapitre TERMINÉ) : on peut
 *   avoir lu 12 chapitres et être à 40 % du 13e.
 * - `current_position_percent` (smallint, nullable) — 0-100.
 * - `current_position_updated_at` (timestamptz, nullable) — horodatage
 *   serveur de la dernière écriture acceptée. `timestamptz` (et non
 *   `timestamp` comme le `lastUpdated` historique) parce que la donnée est
 *   comparée entre appareils potentiellement dans des fuseaux différents.
 *
 * Invariant applicatif : quand `user_read_chapters` atteint ou dépasse
 * `current_chapter`, le chapitre est terminé et la position devient caduque
 * → les trois colonnes repassent à NULL dans la même transaction
 * (`LibraryService.applyChapterPointer`).
 *
 * ## Contrainte CHECK
 *
 * `chk_user_manga_reading_position` verrouille les bornes au niveau BDD
 * (percent 0-100, chapitre ≥ 0) : le DTO valide déjà, mais l'invariant doit
 * survivre à une correction SQL manuelle.
 *
 * ## Index
 *
 * `idx_user_manga_user_id_manga_id` : les deux routes de reprise
 * (`PUT /library/reading-position`, `GET /library/:muId/reading-position`)
 * filtrent exactement sur ce couple, comme toutes les mutations de
 * bibliothèque existantes. La table ne portait qu'un index sur `manga_id`
 * seul. Aucun index dédié aux nouvelles colonnes : elles ne sont jamais un
 * critère de filtre, uniquement des colonnes lues/écrites sur une ligne déjà
 * localisée (87 lignes en prod, 80 kB — coût d'écriture négligeable).
 *
 * Additive et idempotente (`hasColumn` / `IF NOT EXISTS` / lookup
 * `pg_constraint`) → sûre avec `migrationsRun: true` en production. Aucune
 * migration de data : toutes les lignes existantes restent à NULL, ce qui
 * signifie « aucune lecture en cours » — comportement identique à
 * aujourd'hui tant qu'aucun client n'écrit.
 */
export class AddReadingPositionToUserManga1788393600000
  implements MigrationInterface
{
  name = 'AddReadingPositionToUserManga1788393600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DATABASE_SCHEMA ?? 'public';

    const columns = [
      new TableColumn({
        name: 'current_chapter',
        type: 'int',
        isNullable: true,
      }),
      new TableColumn({
        name: 'current_position_percent',
        type: 'smallint',
        isNullable: true,
      }),
      new TableColumn({
        name: 'current_position_updated_at',
        type: 'timestamptz',
        isNullable: true,
      }),
    ];

    for (const column of columns) {
      const exists = await queryRunner.hasColumn('user_manga', column.name);
      if (!exists) {
        await queryRunner.addColumn('user_manga', column);
      }
    }

    const checkRows: { exists: boolean }[] = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conname = 'chk_user_manga_reading_position'
       ) AS exists`,
    );
    if (!checkRows[0]?.exists) {
      await queryRunner.query(
        `ALTER TABLE "${schema}"."user_manga"
           ADD CONSTRAINT "chk_user_manga_reading_position" CHECK (
             ("current_position_percent" IS NULL
               OR ("current_position_percent" >= 0 AND "current_position_percent" <= 100))
             AND ("current_chapter" IS NULL OR "current_chapter" >= 0)
           )`,
      );
    }

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_user_manga_user_id_manga_id"
         ON "${schema}"."user_manga" ("user_id", "manga_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DATABASE_SCHEMA ?? 'public';

    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."idx_user_manga_user_id_manga_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "${schema}"."user_manga"
         DROP CONSTRAINT IF EXISTS "chk_user_manga_reading_position"`,
    );

    for (const column of [
      'current_position_updated_at',
      'current_position_percent',
      'current_chapter',
    ]) {
      const exists = await queryRunner.hasColumn('user_manga', column);
      if (exists) {
        await queryRunner.dropColumn('user_manga', column);
      }
    }
  }
}
