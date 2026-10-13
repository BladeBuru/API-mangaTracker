import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crée `notification` — centre de notifications in-app unifié (demandes et
 * acceptations d'amitié, partages, invitations à un groupe de lecture,
 * nouveaux chapitres).
 *
 * - `user_id` : destinataire, FK CASCADE (suppression du compte, RGPD
 *   article 17).
 * - `actor_id` : auteur de l'événement, FK SET NULL (un compte supprimé ne
 *   fait pas disparaître les notifications de ses amis, il devient anonyme).
 * - `mu_id` : manga concerné, FK CASCADE vers `manga.mu_id` comme les autres
 *   tables du domaine.
 * - `created_at` / `read_at` en `timestamptz(3)` : la pagination renvoie
 *   `createdAt` au client à la milliseconde ; une précision supérieure ferait
 *   sauter des lignes à la frontière des pages.
 * - `IDX_notification_user_read_created` : liste et compteur de non lues.
 * - `UQ_notification_new_chapters_unread` (unique PARTIEL) : au plus une
 *   notification « nouveaux chapitres » non lue par (utilisateur, manga) —
 *   cible de l'`ON CONFLICT` de l'upsert ensembliste du job des sorties.
 *
 * Additive et idempotente, démarre vide. `gen_random_uuid()` : natif depuis
 * PostgreSQL 13, sans extension (même choix que `auth_tokens`).
 */
export class CreateNotification1788912000000 implements MigrationInterface {
  name = 'CreateNotification1788912000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notification" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" integer NOT NULL,
        "type" character varying(32) NOT NULL,
        "actor_id" integer NULL,
        "mu_id" bigint NULL,
        "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "read_at" TIMESTAMP(3) WITH TIME ZONE NULL DEFAULT NULL,
        CONSTRAINT "PK_notification_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_notification_user" FOREIGN KEY ("user_id")
          REFERENCES "user"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_notification_actor" FOREIGN KEY ("actor_id")
          REFERENCES "user"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_notification_manga" FOREIGN KEY ("mu_id")
          REFERENCES "manga"("mu_id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_user_read_created" ON "notification" ("user_id", "read_at", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_actor" ON "notification" ("actor_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notification_mu_id" ON "notification" ("mu_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_notification_new_chapters_unread" ON "notification" ("user_id", "mu_id") WHERE "type" = 'new_chapters' AND "read_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "notification"`);
  }
}
