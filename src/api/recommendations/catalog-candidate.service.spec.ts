import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CatalogCandidateService } from './catalog-candidate.service';
import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { NSFW_GENRES } from '@/api/mangas/constants';
import { ReadingStatus } from '@/api/library/reading-status.enum';

function makeManga(overrides: Partial<Manga> = {}): Manga {
  const manga = new Manga();
  manga.id = 1;
  manga.mu_id = '1000';
  manga.title = 'Manga 1000';
  manga.rating = 8.0;
  manga.genres = ['Action'];
  return Object.assign(manga, overrides);
}

function makeUserManga(overrides: Partial<UserManga> = {}): UserManga {
  const um = new UserManga();
  um.id = 1;
  um.user_rating = 0;
  um.readingStatus = ReadingStatus.Reading;
  um.adding_date = new Date(); // récent → recency ~1.0
  um.manga = makeManga();
  return Object.assign(um, overrides);
}

describe('CatalogCandidateService', () => {
  let service: CatalogCandidateService;
  let qb: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    getMany: jest.Mock;
  };
  let mangaRepo: { createQueryBuilder: jest.Mock };

  /** Récupère les params passés au andWhere qui contient `fragment`. */
  function paramsOf(fragment: string): Record<string, unknown> | undefined {
    const call = qb.andWhere.mock.calls.find((c) =>
      (c[0] as string).includes(fragment),
    );
    return call?.[1] as Record<string, unknown> | undefined;
  }

  beforeEach(async () => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    mangaRepo = { createQueryBuilder: jest.fn(() => qb) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogCandidateService,
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
      ],
    }).compile();

    service = module.get<CatalogCandidateService>(CatalogCandidateService);
  });

  describe('genres favoris', () => {
    it('interroge le catalogue avec le top 5 des genres de la biblio', async () => {
      // Action×3, Romance×2, Comedy/Drama/Fantasy×1, Horror×1 (6 genres).
      const library = [
        makeUserManga({
          manga: makeManga({ mu_id: '1', genres: ['Action', 'Romance'] }),
        }),
        makeUserManga({
          id: 2,
          manga: makeManga({ mu_id: '2', genres: ['Action', 'Romance'] }),
        }),
        makeUserManga({
          id: 3,
          manga: makeManga({ mu_id: '3', genres: ['Action', 'Comedy'] }),
        }),
        makeUserManga({
          id: 4,
          manga: makeManga({ mu_id: '4', genres: ['Drama', 'Fantasy'] }),
        }),
        makeUserManga({
          id: 5,
          manga: makeManga({ mu_id: '5', genres: ['Horror'] }),
        }),
      ];

      await service.findCandidates(library, new Set());

      const params = paramsOf('topGenres');
      expect(params).toBeDefined();
      const topGenres = params!.topGenres as string[];
      expect(topGenres).toHaveLength(5);
      expect(topGenres).toContain('Action');
      expect(topGenres).toContain('Romance');
      // 6 genres en biblio → un seul est exclu du top 5.
      const all = ['Action', 'Romance', 'Comedy', 'Drama', 'Fantasy', 'Horror'];
      expect(all.filter((g) => !topGenres.includes(g))).toHaveLength(1);
    });

    it('retourne [] sans requête si la biblio n’a aucun genre', async () => {
      const library = [
        makeUserManga({ manga: makeManga({ genres: undefined }) }),
      ];
      const result = await service.findCandidates(library, new Set());
      expect(result).toEqual([]);
      expect(mangaRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('formule de score', () => {
    it('candidat mono-genre rating 9 → 8 × 1 × (0.5 + 0.5 × 5/7) ≈ 6.86, sous une reco MU forte (12)', async () => {
      // Biblio mono-genre : share(Action) = 1.
      const library = [
        makeUserManga({ manga: makeManga({ genres: ['Action'] }) }),
      ];
      qb.getMany.mockResolvedValue([
        makeManga({ mu_id: '9000', rating: 9, genres: ['Action'] }),
      ]);

      const result = await service.findCandidates(library, new Set());

      expect(result).toHaveLength(1);
      // ratingBoost = clamp((9 − 6.5) / 3.5, 0, 1) = 0.7142…
      expect(result[0].score).toBeCloseTo(8 * 1 * (0.5 + 0.5 * (2.5 / 3.5)), 4);
      // Ne double jamais une reco MU forte (weight 10 × multiplier 1.2 = 12).
      expect(result[0].score).toBeLessThan(12);
    });

    it('borne ratingBoost à [0, 1] (rating 10 → boost 1)', async () => {
      const library = [
        makeUserManga({ manga: makeManga({ genres: ['Action'] }) }),
      ];
      qb.getMany.mockResolvedValue([
        makeManga({ mu_id: '9000', rating: 10, genres: ['Action'] }),
      ]);

      const result = await service.findCandidates(library, new Set());
      expect(result[0].score).toBeCloseTo(8 * 1 * (0.5 + 0.5 * 1), 4);
    });

    it('sourceMuIds = les 2 mangas biblio au multiplicateur le plus élevé sur le genre dominant', async () => {
      const library = [
        makeUserManga({
          manga: makeManga({ mu_id: '1000', genres: ['Action'] }),
          readingStatus: ReadingStatus.Completed, // ×1.5
        }),
        makeUserManga({
          id: 2,
          manga: makeManga({ id: 2, mu_id: '1001', genres: ['Action'] }),
          readingStatus: ReadingStatus.Reading, // ×1.2
        }),
        makeUserManga({
          id: 3,
          manga: makeManga({ id: 3, mu_id: '1002', genres: ['Action'] }),
          readingStatus: ReadingStatus.ReadLater, // ×0.8
        }),
      ];
      qb.getMany.mockResolvedValue([
        makeManga({ mu_id: '9000', rating: 8, genres: ['Action'] }),
      ]);

      const result = await service.findCandidates(library, new Set());
      expect(result[0].sourceMuIds).toEqual(['1000', '1001']);
    });
  });

  describe('paramètres SQL', () => {
    it('exclut la biblio, les genres NSFW, et applique le plancher de note + tri/limit', async () => {
      const library = [
        makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
        makeUserManga({
          id: 2,
          manga: makeManga({ id: 2, mu_id: '1001' }),
        }),
      ];

      await service.findCandidates(library, new Set(['1000', '1001']));

      expect(qb.where).toHaveBeenCalledWith('m.genres IS NOT NULL');
      const nsfwParams = paramsOf('nsfwGenres');
      expect(nsfwParams!.nsfwGenres).toEqual(NSFW_GENRES);
      const floorParams = paramsOf('ratingFloor');
      expect(floorParams!.ratingFloor).toBe(7.0);
      const excludeParams = paramsOf('excludeMuIds');
      expect(excludeParams!.excludeMuIds).toEqual(
        expect.arrayContaining(['1000', '1001']),
      );
      expect(qb.orderBy).toHaveBeenCalledWith('m.rating', 'DESC');
      expect(qb.limit).toHaveBeenCalledWith(300);
    });

    it("n'ajoute pas de clause NOT IN quand excludeMuIds est vide", async () => {
      const library = [makeUserManga()];
      await service.findCandidates(library, new Set());
      expect(paramsOf('excludeMuIds')).toBeUndefined();
    });
  });

  describe('type de publication (manga / manhwa / manhua)', () => {
    /** Bibliothèque fidèle à la prod : 8 manhwa, 2 manga — préférence marquée. */
    function manhwaLibrary() {
      return [
        ...Array.from({ length: 8 }, (_, i) =>
          makeUserManga({
            id: i + 1,
            manga: makeManga({ mu_id: `${100 + i}`, type: 'Manhwa' }),
          }),
        ),
        ...Array.from({ length: 2 }, (_, i) =>
          makeUserManga({
            id: 20 + i,
            manga: makeManga({ mu_id: `${200 + i}`, type: 'Manga' }),
          }),
        ),
      ];
    }

    /** Catalogue simulé : chaque bucket reçoit ses propres lignes. */
    function mockTypedCatalog(rowsByType: Record<string, Manga[]>) {
      const created: Array<{ type: string | null; limit: number }> = [];
      mangaRepo.createQueryBuilder.mockImplementation(() => {
        const state: { type: string | null; limit: number } = {
          type: 'all',
          limit: 0,
        };
        const q = {
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn((sql: string, params?: { bucketType?: string }) => {
            if (sql === 'm.type = :bucketType') {
              state.type = params?.bucketType ?? null;
            } else if (sql === 'm.type IS NULL') {
              state.type = null;
            } else if (sql === 'm.type IS NOT NULL') {
              state.type = 'other';
            }
            return q;
          }),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn((n: number) => {
            state.limit = n;
            return q;
          }),
          getMany: jest.fn(async () => {
            created.push({ ...state });
            const key = state.type === null ? 'null' : state.type;
            return rowsByType[key] ?? [];
          }),
        };
        return q;
      });
      return created;
    }

    function catalogRows(prefix: number, type: string | null, n: number) {
      return Array.from({ length: n }, (_, i) =>
        makeManga({
          id: prefix + i,
          mu_id: `${prefix + i}`,
          // Les mangas sont mieux notés que les manhwa : sans prorata, un
          // tri global par note ne remonterait QUE des mangas.
          rating: type === 'Manga' ? 9 - i * 0.01 : 8 - i * 0.01,
          genres: ['Action'],
          type,
        }),
      );
    }

    it('interroge le catalogue par bucket de type au prorata du profil (manhwa, manga, inconnus, découverte)', async () => {
      const calls = mockTypedCatalog({
        Manhwa: catalogRows(3000, 'Manhwa', 5),
        Manga: catalogRows(2000, 'Manga', 5),
        null: catalogRows(4000, null, 5),
        other: [],
      });

      await service.findCandidates(manhwaLibrary(), new Set());

      const byType = new Map(calls.map((c) => [String(c.type), c.limit]));
      // 8/10 × 300 = 240 manhwa, 2/10 × 300 = 60 mangas, 35 % d'inconnus
      // (préférence marquée), 10 % de découverte.
      expect(byType.get('Manhwa')).toBe(240);
      expect(byType.get('Manga')).toBe(60);
      expect(byType.get('null')).toBe(105);
      expect(byType.get('other')).toBe(30);
      expect(byType.has('all')).toBe(false);
    });

    it('un lecteur à 80 % manhwa obtient des candidats manhwa en tête et ≈ 80 % de manhwa', async () => {
      mockTypedCatalog({
        Manhwa: catalogRows(3000, 'Manhwa', 40),
        Manga: catalogRows(2000, 'Manga', 40),
        null: [],
        other: [],
      });

      const candidates = await service.findCandidates(
        manhwaLibrary(),
        new Set(),
        20,
      );

      expect(candidates).toHaveLength(20);
      expect(candidates[0].type).toBe('Manhwa');
      expect(candidates.filter((c) => c.type === 'Manhwa')).toHaveLength(16);
      expect(candidates.filter((c) => c.type === 'Manga')).toHaveLength(4);
    });

    it('sans type connu en bibliothèque : une seule requête sans filtre (comportement historique)', async () => {
      const calls = mockTypedCatalog({ all: catalogRows(2000, null, 3) });

      const candidates = await service.findCandidates(
        [makeUserManga({ manga: makeManga({ mu_id: '1' }) })],
        new Set(),
      );

      expect(calls).toEqual([{ type: 'all', limit: 300 }]);
      expect(candidates.map((c) => c.type)).toEqual([null, null, null]);
    });
  });
});
