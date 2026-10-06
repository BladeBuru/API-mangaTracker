import { DataSource, QueryRunner } from 'typeorm';

/**
 * Base PostgreSQL des tests d'intégration (fournie par la CI, variables
 * `DATABASE_*`). Sans base joignable, les suites sont ignorées.
 *
 * Nom en `*.helper-spec.ts` : exclu du build (`**\/*spec.ts`) sans être pris
 * pour un fichier de tests par Jest (`.spec.ts`).
 */
export const hasIntegrationDatabase = Boolean(process.env.DATABASE_HOST);

export function buildIntegrationDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
    database: process.env.DATABASE_NAME,
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    schema: process.env.DATABASE_SCHEMA ?? 'public',
    entities: [__dirname + '/../../**/*.entity.ts'],
    migrations: [__dirname + '/../../migrations/*.ts'],
    migrationsTableName: 'typeorm_migrations',
    synchronize: false,
    logging: false,
  });
}

/** Clé du verrou commun à toutes les suites d'intégration. */
const LOCK_KEY = 7_340_211;

/**
 * Jest exécute les fichiers en parallèle : deux suites qui vident les mêmes
 * tables (`TRUNCATE "user" … CASCADE`) se détruisaient leurs données. Un
 * verrou consultatif PostgreSQL, tenu pendant toute la suite, les sérialise.
 * À prendre AVANT les migrations (elles non plus ne supportent pas d'être
 * jouées deux fois en même temps).
 */
export async function openIntegrationDatabase(): Promise<{
  ds: DataSource;
  close: () => Promise<void>;
}> {
  const ds = buildIntegrationDataSource();
  await ds.initialize();
  const lock: QueryRunner = ds.createQueryRunner();
  await lock.connect();
  await lock.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  await ds.runMigrations();
  return {
    ds,
    close: async () => {
      try {
        await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
        await lock.release();
      } finally {
        if (ds.isInitialized) await ds.destroy();
      }
    },
  };
}
