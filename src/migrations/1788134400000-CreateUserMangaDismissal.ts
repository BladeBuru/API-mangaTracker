import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/**
 * Crée la table `user_manga_dismissal` — fonctionnalité « pas intéressé /
 * déjà vu » sur les recommandations.
 *
 * Un rejet retire définitivement (mais réversiblement) un titre de TOUS les
 * chemins de recommandation de l'utilisateur. La raison est typée et
 * obligatoire (`already_read` / `not_interested` / `seen_elsewhere`) : c'est
 * le signal négatif explicite qui manque au produit — la base de prod ne
 * contient que 4 notes utilisateur pour 6 comptes.
 *
 * - `reason` en `varchar(32)` et non en enum PostgreSQL : convention du repo
 *   (cf. `user_manga.readingStatus`), et une nouvelle valeur ne demande alors
 *   aucune migration.
 * - Unicité (user_id, manga_id) : un rejet actif par titre et par user, le
 *   nouveau écrase l'ancien (upsert `ON CONFLICT DO UPDATE` → index UNIQUE
 *   requis).
 * - `IDX_dismissal_user` : la liste des rejets est lue à chaque calcul de
 *   recommandations (chemin chaud).
 * - FK CASCADE sur `user` et `manga`, comme `user_manga` et
 *   `manga_chapter_report`.
 *
 * Pas de migration de data — la table démarre vide.
 */
export class CreateUserMangaDismissal1788134400000
  implements MigrationInterface
{
  name = 'CreateUserMangaDismissal1788134400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('user_manga_dismissal');
    if (exists) return;

    await queryRunner.createTable(
      new Table({
        name: 'user_manga_dismissal',
        columns: [
          {
            name: 'id',
            type: 'int',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'user_id', type: 'int', isNullable: false },
          { name: 'manga_id', type: 'bigint', isNullable: false },
          { name: 'reason', type: 'varchar', length: '32', isNullable: false },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
        ],
        foreignKeys: [
          {
            columnNames: ['user_id'],
            referencedTableName: 'user',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
          {
            columnNames: ['manga_id'],
            referencedTableName: 'manga',
            referencedColumnNames: ['mu_id'],
            onDelete: 'CASCADE',
          },
        ],
        indices: [
          {
            name: 'UQ_dismissal_user_manga',
            columnNames: ['user_id', 'manga_id'],
            isUnique: true,
          },
          {
            name: 'IDX_dismissal_user',
            columnNames: ['user_id'],
          },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const exists = await queryRunner.hasTable('user_manga_dismissal');
    if (exists) await queryRunner.dropTable('user_manga_dismissal');
  }
}
