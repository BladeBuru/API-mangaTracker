import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ajoute un index unique **case-insensitive** sur `user.username`.
 *
 * Sans ça, `John` et `john` pouvaient coexister, et la recherche
 * d'utilisateurs (`FriendsService.searchUsers` / `sendRequest`) avec
 * `ILIKE` retournait potentiellement plusieurs match pour un même
 * identifiant.
 *
 * **Stratégie** : `CREATE UNIQUE INDEX ON "user" (LOWER(username))`.
 * Postgres-only — l'index est sur l'expression `LOWER(username)`, ce
 * qui force l'unicité après normalisation.
 *
 * Si la migration échoue parce que des doublons existent déjà, la
 * commande échouera proprement et il faudra dédupliquer manuellement
 * en BDD avant de réessayer. C'est volontaire — on n'a pas envie de
 * supprimer automatiquement des comptes utilisateurs.
 */
export class AddUsernameUniqueIndex1746231500000 implements MigrationInterface {
  name = 'AddUsernameUniqueIndex1746231500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // TypeORM ne propage PAS le `search_path` aux requêtes raw — il faut
    // qualifier la table avec le schema configuré dans la data-source.
    // On utilise `process.env.DATABASE_SCHEMA` car `current_schema()` côté
    // session Postgres retourne `public` indépendamment de l'option TypeORM,
    // et `options.schema` est typé strict (union DataSourceOptions le rejette).
    const schema = process.env.DATABASE_SCHEMA ?? 'public';

    // Vérifier l'absence de doublons case-insensitive avant la création
    // de l'index — sinon CREATE UNIQUE INDEX throw avec un message peu
    // clair. On log les éventuels conflits pour l'admin.
    const duplicates = await queryRunner.query(`
      SELECT LOWER(username) AS lname, COUNT(*) AS cnt
      FROM "${schema}"."user"
      GROUP BY LOWER(username)
      HAVING COUNT(*) > 1
    `);
    if (duplicates.length > 0) {
      throw new Error(
        `Cannot add unique index on LOWER(username) — duplicates exist: ` +
          JSON.stringify(duplicates) +
          `\nDeduplicate manually (e.g. rename one of the conflicting users) then retry.`,
      );
    }

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_user_username_lower" ON "${schema}"."user" (LOWER(username))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DATABASE_SCHEMA ?? 'public';
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."UQ_user_username_lower"`,
    );
  }
}
