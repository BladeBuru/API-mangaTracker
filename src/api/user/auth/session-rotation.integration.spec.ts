import { DataSource } from 'typeorm';
import User from '@/api/user/user.entity';
import { AuthHelper, REFRESH_REPLAY_GRACE_MS } from './auth.helper';
import { UserSession } from './user-session.entity';

/**
 * Rotation des refresh tokens sur un VRAI PostgreSQL (verrou de ligne,
 * migrations) : c'est elle qui décidait des déconnexions « au hasard ».
 * Ignorée sans base (poste de dev) ; toujours exécutée en CI.
 */
const hasDatabase = Boolean(process.env.DATABASE_HOST);

function buildDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
    database: process.env.DATABASE_NAME,
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    schema: process.env.DATABASE_SCHEMA ?? 'public',
    entities: [__dirname + '/../../**/*.entity.ts'],
    migrations: [__dirname + '/../../../migrations/*.ts'],
    migrationsTableName: 'typeorm_migrations',
    synchronize: false,
    logging: false,
  });
}

(hasDatabase ? describe : describe.skip)(
  'Rotation des sessions — intégration PostgreSQL',
  () => {
    jest.setTimeout(120_000);

    let ds: DataSource;
    let helper: AuthHelper;
    let user: User;

    beforeAll(async () => {
      ds = buildDataSource();
      await ds.initialize();
      await ds.runMigrations();
      helper = new AuthHelper(null);
      Object.assign(helper, {
        repository: ds.getRepository(User),
        sessionRepository: ds.getRepository(UserSession),
      });
    });

    afterAll(async () => {
      if (ds?.isInitialized) await ds.destroy();
    });

    beforeEach(async () => {
      await ds.query('TRUNCATE "user" RESTART IDENTITY CASCADE');
      const users = ds.getRepository(User);
      user = await users.save(
        users.create({ username: 'lecteur', email: 'l@example.test' }),
      );
    });

    const sessionsCount = () =>
      ds.getRepository(UserSession).count({ where: { userId: user.id } });

    it("le premier échange crée une session et marque l'ancienne", async () => {
      const first = await helper.createSession(user, 'téléphone');
      const next = await helper.rotateSession(first.id);

      expect(next).toBeTruthy();
      expect(next).not.toBe(first.id);
      const old = await ds
        .getRepository(UserSession)
        .findOneByOrFail({ id: first.id });
      expect(old.rotatedAt).not.toBeNull();
      expect(old.replacedById).toBe(next);
      const created = await ds
        .getRepository(UserSession)
        .findOneByOrFail({ id: next });
      expect(created.deviceInfo).toBe('téléphone');
    });

    it('réponse perdue : le même jeton redonne la même session, sans en créer', async () => {
      const first = await helper.createSession(user);
      const next = await helper.rotateSession(first.id);
      const replay = await helper.rotateSession(first.id);

      expect(replay).toBe(next);
      expect(await sessionsCount()).toBe(2);
    });

    it('rejeu hors délai : refusé (jeton réellement périmé)', async () => {
      const first = await helper.createSession(user);
      await helper.rotateSession(first.id);
      const late = new Date(Date.now() + REFRESH_REPLAY_GRACE_MS + 1000);

      expect(await helper.rotateSession(first.id, late)).toBeNull();
    });

    it('deux échanges simultanés du même jeton convergent', async () => {
      const first = await helper.createSession(user);
      const [a, b] = await Promise.all([
        helper.rotateSession(first.id),
        helper.rotateSession(first.id),
      ]);

      expect(a).toBeTruthy();
      expect(a).toBe(b);
      expect(await sessionsCount()).toBe(2);
    });

    it("un rejeu suit la chaîne jusqu'à la session courante", async () => {
      const s1 = await helper.createSession(user);
      const s2 = await helper.rotateSession(s1.id);
      const s3 = await helper.rotateSession(s2);

      expect(await helper.rotateSession(s1.id)).toBe(s3);
    });

    it('session inconnue : refus', async () => {
      expect(
        await helper.rotateSession('00000000-0000-4000-8000-000000000000'),
      ).toBeNull();
    });

    it("chaque appareil garde sa session (aucune n'en révoque une autre)", async () => {
      const phone = await helper.createSession(user, 'téléphone');
      const tablet = await helper.createSession(user, 'tablette');

      const phoneNext = await helper.rotateSession(phone.id);
      const tabletNext = await helper.rotateSession(tablet.id);

      expect(phoneNext).toBeTruthy();
      expect(tabletNext).toBeTruthy();
      expect(phoneNext).not.toBe(tabletNext);
    });

    it('la purge ne retire que les sessions échangées depuis plus d’un jour', async () => {
      const old = await helper.createSession(user);
      const kept = await helper.createSession(user);
      await helper.rotateSession(old.id, new Date(Date.now() - 2 * 86_400_000));
      await helper.rotateSession(kept.id);

      await helper.purgeRotatedSessions(user.id);

      const ids = (
        await ds.getRepository(UserSession).find({
          where: { userId: user.id },
        })
      ).map((s) => s.id);
      expect(ids).not.toContain(old.id);
      expect(ids).toContain(kept.id);
    });
  },
);
