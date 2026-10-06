import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MangasService } from '@/api/mangas/mangas.service';
import { MangaDetailsDto } from '@/api/mangas/dto/manga-details.dto';
import { DataSource } from 'typeorm';
import {
  hasIntegrationDatabase,
  openIntegrationDatabase,
} from '@/shared/testing/integration-db.helper-spec';
import { Manga } from '@/api/mangas/manga.entity';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import User from '@/api/user/user.entity';
import { UserMangaRecommendation } from './user-manga-recommendation.entity';
import { CommunityRecommendationService } from './community-recommendation.service';
import { RatingSummaryService } from './rating-summary.service';
import { GdprService } from '@/api/user/gdpr/gdpr.service';
import { findCoReadings } from '@/api/mangas/co-reading.query';
import { UserSession } from '@/api/user/auth/user-session.entity';

/**
 * Tests d'intégration sur un VRAI PostgreSQL (migrations comprises) : les
 * requêtes de ce module (agrégats, `BOOL_OR`, casts, contraintes, cascades)
 * ne se vérifient pas avec des mocks.
 *
 * Base fournie par la CI (service `postgres`, variables `DATABASE_*`). Sans
 * base joignable (poste de dev), la suite est ignorée — elle ne passe
 * jamais « verte » en silence en CI puisque la base y est toujours présente.
 */

(hasIntegrationDatabase ? describe : describe.skip)(
  'Communauté — intégration PostgreSQL',
  () => {
    jest.setTimeout(120_000);

    let ds: DataSource;
    let closeDb: (() => Promise<void>) | undefined;
    let recos: CommunityRecommendationService;
    let ratings: RatingSummaryService;
    let alice: User;
    let bob: User;

    const ONE_PIECE = 1001;
    const NARUTO = 1002;
    const BLEACH = 1003;
    const UNKNOWN = 1999;
    /** Connue de MangaUpdates mais pas encore en base. */
    const ON_MU_ONLY = 1500;

    /** Faux MangaUpdates : seule [ON_MU_ONLY] y existe. */
    const getMangaDetails = jest.fn(async (muId: number) => {
      if (muId !== ON_MU_ONLY) {
        throw new NotFoundException(`Manga with id ${muId} cannot be found`);
      }
      const details = new MangaDetailsDto();
      details.muId = ON_MU_ONLY;
      details.title = 'Titre officiel';
      details.year = 2010;
      details.rating = 7.5;
      details.ratingVotes = 40;
      details.associated = [];
      return details;
    });

    beforeAll(async () => {
      const db = await openIntegrationDatabase();
      ds = db.ds;
      closeDb = db.close;
      recos = new CommunityRecommendationService(
        ds.getRepository(Manga),
        ds.getRepository(MangaRecommendation),
        ds.getRepository(UserMangaRecommendation),
        { getMangaDetails } as unknown as MangasService,
      );
      ratings = new RatingSummaryService(
        ds.getRepository(Manga),
        ds.getRepository(UserManga),
      );
    });

    afterAll(async () => {
      await closeDb?.();
    });

    beforeEach(async () => {
      await ds.query(
        'TRUNCATE user_manga_recommendation, manga_recommendation, ' +
          'user_manga, manga, "user" RESTART IDENTITY CASCADE',
      );
      const users = ds.getRepository(User);
      alice = await users.save(
        users.create({ username: 'alice', email: 'a@example.test' }),
      );
      bob = await users.save(
        users.create({ username: 'bob', email: 'b@example.test' }),
      );
      await ds.getRepository(Manga).save([
        { mu_id: `${ONE_PIECE}`, title: 'One Piece', rating: 8.9 },
        { mu_id: `${NARUTO}`, title: 'Naruto', rating: 8.0, rating_votes: 3 },
        { mu_id: `${BLEACH}`, title: 'Bleach', rating: 7.9 },
      ]);
      await ds.getRepository(MangaRecommendation).save([
        {
          source_mu_id: `${ONE_PIECE}`,
          recommended_mu_id: `${NARUTO}`,
          kind: 'manual',
          weight: 72,
        },
        {
          source_mu_id: `${ONE_PIECE}`,
          recommended_mu_id: `${BLEACH}`,
          kind: 'category',
          weight: 30_000,
        },
      ]);
    });

    it('fusionne les votes MangaUpdates et Manga Tracker ; les suggestions MU suivent, sans votes', async () => {
      await recos.recommend(alice.id, ONE_PIECE, NARUTO);
      const list = await recos.list(ONE_PIECE, alice.id);

      expect(list.items).toHaveLength(2);
      expect(list.items[0]).toMatchObject({
        muId: NARUTO,
        title: 'Naruto',
        muVotes: 72,
        appVotes: 1,
        totalVotes: 73,
        recommendedByMe: true,
        muSuggested: false,
      });
      // Lien `category` : listé (titre recommandable) mais son poids n'est
      // jamais présenté comme des votes.
      expect(list.items[1]).toMatchObject({
        muId: BLEACH,
        muVotes: 0,
        appVotes: 0,
        totalVotes: 0,
        muSuggested: true,
      });
    });

    it('un titre sans recommandation déposée sur MU a quand même une liste', async () => {
      await ds.getRepository(Manga).save({ mu_id: '1700', title: 'Manhwa' });
      await ds.getRepository(MangaRecommendation).save([
        {
          source_mu_id: '1700',
          recommended_mu_id: `${NARUTO}`,
          kind: 'category',
          weight: 12_000,
        },
        {
          source_mu_id: '1700',
          recommended_mu_id: `${BLEACH}`,
          kind: 'category',
          weight: 15_000,
        },
      ]);
      const list = await recos.list(1700, alice.id);
      expect(list.items.map((i) => i.muId)).toEqual([BLEACH, NARUTO]);

      // Un vote fait passer la suggestion devant.
      await recos.recommend(bob.id, 1700, NARUTO);
      const after = await recos.list(1700, alice.id);
      expect(after.items[0]).toMatchObject({
        muId: NARUTO,
        appVotes: 1,
        muSuggested: true,
      });
    });

    it('« les lecteurs lisent aussi » ne compte pas le demandeur', async () => {
      const userMangas = ds.getRepository(UserManga);
      for (const [user, muId] of [
        [alice, ONE_PIECE],
        [alice, NARUTO],
        [bob, ONE_PIECE],
        [bob, BLEACH],
      ] as const) {
        await userMangas.save(
          userMangas.create({
            user: { id: user.id },
            manga: { mu_id: `${muId}` },
          } as Partial<UserManga>),
        );
      }
      const forAlice = await findCoReadings(
        userMangas,
        ONE_PIECE,
        10,
        alice.id,
      );
      expect(forAlice.map((r) => r.recommended_mu_id)).toEqual([`${BLEACH}`]);
    });

    it('un second vote du même utilisateur ne compte pas', async () => {
      await recos.recommend(alice.id, ONE_PIECE, NARUTO);
      const again = await recos.recommend(alice.id, ONE_PIECE, NARUTO);
      expect(again.appVotes).toBe(1);
    });

    it("recommander une œuvre absente de la base crée sa fiche d'après MangaUpdates", async () => {
      const item = await recos.recommend(bob.id, ONE_PIECE, ON_MU_ONLY);
      expect(item).toMatchObject({
        muId: ON_MU_ONLY,
        title: 'Titre officiel',
        appVotes: 1,
        recommendedByMe: true,
      });
      const stored = await ds
        .getRepository(Manga)
        .findOneByOrFail({ mu_id: `${ON_MU_ONLY}` });
      expect(stored.rating_votes).toBe(40);

      const forAlice = await recos.list(ONE_PIECE, alice.id);
      const created = forAlice.items.find((i) => i.muId === ON_MU_ONLY);
      expect(created?.recommendedByMe).toBe(false);
    });

    it('refuse une cible inconnue de MangaUpdates, sans rien créer', async () => {
      await expect(
        recos.recommend(alice.id, ONE_PIECE, UNKNOWN),
      ).rejects.toBeInstanceOf(NotFoundException);
      const created = await ds
        .getRepository(Manga)
        .exist({ where: { mu_id: `${UNKNOWN}` } });
      expect(created).toBe(false);
    });

    it("n'interroge pas MangaUpdates pour une cible déjà en base", async () => {
      getMangaDetails.mockClear();
      await recos.recommend(alice.id, ONE_PIECE, BLEACH);
      expect(getMangaDetails).not.toHaveBeenCalled();
    });

    it('le tri suit le total de votes', async () => {
      await recos.recommend(alice.id, ONE_PIECE, BLEACH);
      await recos.recommend(bob.id, ONE_PIECE, BLEACH);
      const list = await recos.list(ONE_PIECE, alice.id);
      expect(list.items.map((i) => [i.muId, i.totalVotes])).toEqual([
        [NARUTO, 72],
        [BLEACH, 2],
      ]);
    });

    it('retirer sa recommandation décrémente le compteur', async () => {
      await recos.recommend(alice.id, ONE_PIECE, NARUTO);
      const item = await recos.unrecommend(alice.id, ONE_PIECE, NARUTO);
      expect(item).toMatchObject({
        appVotes: 0,
        totalVotes: 72,
        recommendedByMe: false,
      });
    });

    it('refuse une œuvre recommandée pour elle-même, ou une source inconnue', async () => {
      await expect(
        recos.recommend(alice.id, ONE_PIECE, ONE_PIECE),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        recos.recommend(alice.id, UNKNOWN, NARUTO),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('la suppression du compte efface ses recommandations (RGPD)', async () => {
      await recos.recommend(alice.id, ONE_PIECE, NARUTO);
      await ds.getRepository(User).delete(alice.id);
      const list = await recos.list(ONE_PIECE, bob.id);
      expect(list.items[0].appVotes).toBe(0);
    });

    it("l'export RGPD (article 20) contient les recommandations publiées", async () => {
      await recos.recommend(alice.id, ONE_PIECE, NARUTO);
      const gdpr = new GdprService(
        ds.getRepository(User),
        ds.getRepository(UserManga),
        ds.getRepository(UserSession),
        ds.getRepository(UserMangaRecommendation),
      );
      const exported = await gdpr.exportUserData(alice.id);
      expect(exported.communityRecommendations).toEqual([
        expect.objectContaining({
          sourceMuId: `${ONE_PIECE}`,
          recommendedMuId: `${NARUTO}`,
        }),
      ]);
      const forBob = await gdpr.exportUserData(bob.id);
      expect(forBob.communityRecommendations).toEqual([]);
      const summary = await gdpr.getDataSummary(alice.id);
      expect(summary.recommendationsCount).toBe(1);
    });

    it('note globale : 3 votes MU à 8 + 1 vote local à 4 → 7, 4 votes', async () => {
      await ds.getRepository(UserManga).save({
        user: alice,
        manga: { mu_id: `${NARUTO}` } as Manga,
        user_rating: 4,
      });
      const summary = await ratings.getSummary(NARUTO);
      expect(summary).toEqual({
        mu_rating: 8,
        mu_rating_votes: 3,
        community_rating: 4,
        community_rating_count: 1,
        aggregated_rating: 7,
        total_rating_votes: 4,
      });
    });

    it('note globale : votants MU inconnus → repli, total = votes locaux', async () => {
      const summary = await ratings.getSummary(BLEACH);
      expect(summary).toMatchObject({
        mu_rating: 7.9,
        mu_rating_votes: null,
        aggregated_rating: 7.9,
        total_rating_votes: 0,
      });
      await expect(ratings.getSummary(UNKNOWN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  },
);
