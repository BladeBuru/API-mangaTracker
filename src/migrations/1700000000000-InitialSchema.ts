import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

/**
 * Migration initiale : crée les tables de base du schéma Manga Tracker.
 *
 * Tables créées :
 *  - `manga`       — catalogue des mangas (sans la colonne `genres`, ajoutée
 *                    par la migration 1746230500000-AddGenresToManga)
 *  - `user`        — comptes utilisateurs (sans colonnes RGPD ni emailVerifiedAt,
 *                    ajoutées par les migrations 1746230600000 et 1746230700000)
 *  - `user_manga`  — bibliothèque personnelle (jointure user ↔ manga)
 *  - `user_session`— sessions de connexion actives
 *
 * Entièrement idempotente : un `hasTable` évite toute erreur si une table
 * existe déjà (environnements de dev qui utilisaient encore synchronize:true).
 */
export class InitialSchema1700000000000 implements MigrationInterface {
  name = 'InitialSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ──────────────────────────────────────────────────────────────────────
    // 1. Table `manga`
    // ──────────────────────────────────────────────────────────────────────
    if (!(await queryRunner.hasTable('manga'))) {
      await queryRunner.createTable(
        new Table({
          name: 'manga',
          columns: [
            {
              name: 'id',
              type: 'int',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            { name: 'title', type: 'varchar', isNullable: false },
            { name: 'small_cover_url', type: 'varchar', isNullable: false },
            { name: 'medium_cover_url', type: 'varchar', isNullable: false },
            {
              name: 'mu_id',
              type: 'bigint',
              isNullable: false,
              isUnique: true,
            },
            {
              name: 'total_chapters',
              type: 'int',
              isNullable: false,
              default: 0,
            },
            {
              name: 'rating',
              type: 'decimal',
              precision: 3,
              scale: 2,
              isNullable: false,
            },
            { name: 'year', type: 'int', isNullable: false },
            { name: 'completed', type: 'boolean', isNullable: true },
            { name: 'associated', type: 'json', isNullable: true },
            {
              name: 'created_at',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
            },
            {
              name: 'updated_at',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
            },
          ],
        }),
        true,
      );
    }

    // ──────────────────────────────────────────────────────────────────────
    // 2. Table `user`
    // Note : les colonnes RGPD (acceptedTos*, acceptedPrivacy*) et
    //        emailVerifiedAt sont ajoutées par les migrations ultérieures.
    // ──────────────────────────────────────────────────────────────────────
    if (!(await queryRunner.hasTable('user'))) {
      await queryRunner.createTable(
        new Table({
          name: 'user',
          columns: [
            {
              name: 'id',
              type: 'int',
              isPrimary: true,
              isGenerated: true,
              generationStrategy: 'increment',
            },
            { name: 'username', type: 'varchar', isNullable: false },
            { name: 'email', type: 'varchar', isNullable: false },
            { name: 'password', type: 'varchar', isNullable: true },
            {
              name: 'googleId',
              type: 'varchar',
              isNullable: true,
              default: null,
            },
            {
              name: 'authProvider',
              type: 'varchar',
              isNullable: false,
              default: "'local'",
            },
            {
              name: 'lastLoginAt',
              type: 'timestamp',
              isNullable: true,
              default: null,
            },
          ],
        }),
        true,
      );
    }

    // ──────────────────────────────────────────────────────────────────────
    // 3. Table `user_manga`
    // FK user_id → user.id  (CASCADE DELETE)
    // FK manga_id → manga.mu_id (bigint, CASCADE DELETE)
    // ──────────────────────────────────────────────────────────────────────
    if (!(await queryRunner.hasTable('user_manga'))) {
      await queryRunner.createTable(
        new Table({
          name: 'user_manga',
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
            {
              name: 'adding_date',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
            },
            {
              name: 'user_rating',
              type: 'int',
              isNullable: false,
              default: 0,
            },
            {
              name: 'user_read_chapters',
              type: 'int',
              isNullable: false,
              default: 0,
            },
            {
              name: 'readingStatus',
              type: 'varchar',
              isNullable: false,
              default: "'readLater'",
            },
            {
              name: 'lastUpdated',
              type: 'timestamp',
              isNullable: true,
              default: null,
            },
            {
              name: 'custom_link',
              type: 'varchar',
              isNullable: true,
              default: null,
            },
          ],
        }),
        true,
      );

      await queryRunner.createForeignKey(
        'user_manga',
        new TableForeignKey({
          name: 'FK_user_manga_user',
          columnNames: ['user_id'],
          referencedTableName: 'user',
          referencedColumnNames: ['id'],
          onDelete: 'CASCADE',
        }),
      );

      await queryRunner.createForeignKey(
        'user_manga',
        new TableForeignKey({
          name: 'FK_user_manga_manga',
          columnNames: ['manga_id'],
          referencedTableName: 'manga',
          referencedColumnNames: ['mu_id'],
          onDelete: 'CASCADE',
        }),
      );
    }

    // ──────────────────────────────────────────────────────────────────────
    // 4. Table `user_session`
    // FK user_id → user.id  (CASCADE DELETE)
    // ──────────────────────────────────────────────────────────────────────
    if (!(await queryRunner.hasTable('user_session'))) {
      await queryRunner.createTable(
        new Table({
          name: 'user_session',
          columns: [
            {
              name: 'id',
              type: 'uuid',
              isPrimary: true,
              isNullable: false,
            },
            { name: 'user_id', type: 'int', isNullable: false },
            {
              name: 'deviceInfo',
              type: 'varchar',
              isNullable: true,
            },
            {
              name: 'createdAt',
              type: 'timestamp',
              default: 'CURRENT_TIMESTAMP',
            },
          ],
        }),
        true,
      );

      await queryRunner.createForeignKey(
        'user_session',
        new TableForeignKey({
          name: 'FK_user_session_user',
          columnNames: ['user_id'],
          referencedTableName: 'user',
          referencedColumnNames: ['id'],
          onDelete: 'CASCADE',
        }),
      );

      // Index pour lookup rapide sessions d'un utilisateur
      await queryRunner.createIndex(
        'user_session',
        new TableIndex({
          name: 'IDX_user_session_user_id',
          columnNames: ['user_id'],
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Suppression dans l'ordre inverse pour respecter les FK
    if (await queryRunner.hasTable('user_session')) {
      await queryRunner.dropTable('user_session', true);
    }
    if (await queryRunner.hasTable('user_manga')) {
      await queryRunner.dropTable('user_manga', true);
    }
    if (await queryRunner.hasTable('user')) {
      await queryRunner.dropTable('user', true);
    }
    if (await queryRunner.hasTable('manga')) {
      await queryRunner.dropTable('manga', true);
    }
  }
}
