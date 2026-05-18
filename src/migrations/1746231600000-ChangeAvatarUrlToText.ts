import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Change `user.avatarUrl` de `varchar(512)` à `text`.
 *
 * **Pourquoi** : on permet désormais à l'utilisateur de choisir une photo
 * depuis sa galerie (en plus du champ URL). Le client Flutter encode
 * l'image en base64 (data URL `data:image/jpeg;base64,...`) car l'upload
 * multipart côté API n'est pas encore câblé (TODO multer + sharp + volume
 * NAS — voir progress.md). Une image 512×512 quality 75 fait ~40-60KB
 * base64 ≈ 60-80K caractères → dépasse `varchar(512)`.
 *
 * `text` est illimité côté Postgres et pas plus coûteux que varchar pour
 * une colonne nullable peu accédée. Quand l'upload multipart sera câblé,
 * on migrera vers une URL `https://nas.../uploads/avatars/{userId}.jpg`
 * et la colonne `text` accommode toujours.
 *
 * **Down** : retour à `varchar(512)`. Si des avatars data-URL > 512 chars
 * existent, ils seront tronqués → données perdues. Ne descend que si la
 * table est connue safe (dev).
 */
export class ChangeAvatarUrlToText1746231600000
  implements MigrationInterface
{
  name = 'ChangeAvatarUrlToText1746231600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // TypeORM ne propage PAS le `search_path` aux requêtes raw → on
    // qualifie via `process.env.DATABASE_SCHEMA` (`dev` en local, `public`
    // en prod). `options.schema` est typé strict sur l'union DataSourceOptions
    // donc TS refuse l'accès direct.
    const schema = process.env.DATABASE_SCHEMA ?? 'public';
    await queryRunner.query(`
      ALTER TABLE "${schema}"."user"
      ALTER COLUMN "avatarUrl" TYPE text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DATABASE_SCHEMA ?? 'public';
    await queryRunner.query(`
      ALTER TABLE "${schema}"."user"
      ALTER COLUMN "avatarUrl" TYPE varchar(512)
    `);
  }
}
