import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RGPD (spec hotfix-v0-10-1 US-1) — purge les usernames au format email.
 *
 * Certains comptes ont leur **adresse email** stockée en `username`
 * (inscription sans validation + fallback Google OAuth). Le username est
 * exposé publiquement (commentaires, profil public, recherche d'amis) →
 * violation de la minimisation des données (art. 5 RGPD). L'OS mobile
 * auto-linkifie en plus le format email → tap = mailto.
 *
 * Pour chaque user dont `username` contient `@` :
 *  1. `displayName` ← part locale de l'email (si displayName vide)
 *  2. `username`    ← part locale sanitisée, suffixe aléatoire si collision
 *     (unicité case-insensitive — index LOWER(username), RETRO-006)
 *
 * Down : no-op volontaire — restaurer les emails en username serait
 * réintroduire la violation RGPD. Les anciens usernames ne sont pas
 * conservés.
 */
export class SanitizeEmailUsernames1749600000000 implements MigrationInterface {
  name = 'SanitizeEmailUsernames1749600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DATABASE_SCHEMA ?? 'public';
    const table = `"${schema}"."user"`;

    const affected: Array<{ id: number; username: string }> =
      await queryRunner.query(
        `SELECT id, username FROM ${table} WHERE username LIKE '%@%'`,
      );

    for (const row of affected) {
      const localPart = row.username
        .split('@')[0]
        .replace(/[^a-zA-Z0-9_. -]/g, '')
        .trim()
        .slice(0, 32);
      const base = localPart.length >= 3 ? localPart : `user${row.id}`;

      // Résolution de collision case-insensitive (RETRO-006) : essayer la
      // part locale, sinon suffixer 4 chiffres aléatoires jusqu'à trouver
      // un username libre.
      let candidate = base;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const clash = await queryRunner.query(
          `SELECT 1 FROM ${table} WHERE LOWER(username) = LOWER($1) AND id != $2 LIMIT 1`,
          [candidate, row.id],
        );
        if (clash.length === 0) break;
        const suffix = String(Math.floor(1000 + Math.random() * 9000));
        candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
      }

      await queryRunner.query(
        `UPDATE ${table}
         SET "displayName" = COALESCE("displayName", $1),
             username = $2
         WHERE id = $3`,
        [base, candidate, row.id],
      );
    }

    // Backfill displayName pour TOUS les comptes où il est null (pas
    // seulement les emails) : le front affiche displayName ?? username,
    // autant le matérialiser pour les comptes existants.
    await queryRunner.query(
      `UPDATE ${table} SET "displayName" = username WHERE "displayName" IS NULL`,
    );
  }

  public async down(): Promise<void> {
    // No-op volontaire : restaurer les emails en username = réintroduire
    // la violation RGPD. Les anciens usernames ne sont pas conservés.
  }
}
