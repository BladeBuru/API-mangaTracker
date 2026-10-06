import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rotation des refresh tokens tolérante aux rejeux.
 *
 * Avant : l'ancienne session était supprimée dès l'échange. Une réponse
 * perdue (réseau coupé à la mise en veille) ou deux requêtes simultanées
 * avec le même jeton laissaient l'appareil avec un jeton mort → déconnexion
 * « au hasard », surtout en lisant sur deux appareils.
 *
 * Désormais l'ancienne ligne est marquée (`rotated_at`, `replaced_by_id`) et
 * purgée plus tard. Additive et idempotente.
 */
export class AddRotationToUserSession1788825600000
  implements MigrationInterface
{
  name = 'AddRotationToUserSession1788825600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "user_session" ADD COLUMN IF NOT EXISTS "rotated_at" TIMESTAMP WITH TIME ZONE NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_session" ADD COLUMN IF NOT EXISTS "replaced_by_id" uuid NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_session_user_rotated" ON "user_session" ("user_id", "rotated_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_user_session_user_rotated"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_session" DROP COLUMN IF EXISTS "replaced_by_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_session" DROP COLUMN IF EXISTS "rotated_at"`,
    );
  }
}
