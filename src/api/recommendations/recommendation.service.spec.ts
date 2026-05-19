import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RecommendationService } from './recommendation.service';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { MangasService } from '@/api/mangas/mangas.service';
import { ReadingStatus } from '@/api/library/reading-status.enum';

/**
 * Helpers pour fabriquer des fixtures lisibles dans les tests.
 */
function makeManga(overrides: Partial<Manga> = {}): Manga {
  const manga = new Manga();
  manga.id = 1;
  manga.mu_id = '1000';
  manga.title = 'Manga Source 1';
  manga.year = 2020;
  manga.small_cover_url = 'https://cdn/small.jpg';
  manga.medium_cover_url = 'https://cdn/medium.jpg';
  manga.rating = 7.5;
  manga.total_chapters = 100;
  return Object.assign(manga, overrides);
}

function makeUserManga(overrides: Partial<UserManga> = {}): UserManga {
  const um = new UserManga();
  um.id = 1;
  um.user_rating = 0;
  um.user_read_chapters = 10;
  um.readingStatus = ReadingStatus.Reading;
  um.adding_date = new Date(); // récent → recencyMultiplier ~1.0
  um.lastUpdated = new Date();
  um.custom_link = null;
  um.manga = makeManga();
  return Object.assign(um, overrides);
}

function makeReco(
  source: string,
  recommended: string,
  weight: number,
  title = 'Recommended Title',
): MangaRecommendation {
  const reco = new MangaRecommendation();
  reco.id = Math.floor(Math.random() * 1_000_000);
  reco.source_mu_id = source;
  reco.recommended_mu_id = recommended;
  reco.weight = weight;
  reco.recommended_title = title;
  reco.updated_at = new Date();
  return reco;
}

describe('RecommendationService', () => {
  let service: RecommendationService;
  // Les mocks sont volontairement étendus avec `createQueryBuilder?: any`
  // pour les tests sleeper hits / segmentation qui overrident dynamiquement
  // la méthode (faux QueryBuilder).
  let userMangaRepo: { find: jest.Mock; createQueryBuilder?: any };
  let recoRepo: { find: jest.Mock; createQueryBuilder?: any };
  let mangaRepo: { find: jest.Mock; createQueryBuilder?: any };
  let mangasService: {
    getCachedRecommendations: jest.Mock;
    fetchAndCacheRecommendations: jest.Mock;
    getCommunityRatings: jest.Mock;
  };

  beforeEach(async () => {
    userMangaRepo = { find: jest.fn().mockResolvedValue([]) };
    recoRepo = { find: jest.fn().mockResolvedValue([]) };
    mangaRepo = { find: jest.fn().mockResolvedValue([]) };
    mangasService = {
      // Defaults safe : retournent toujours des arrays résolus pour éviter
      // les throws synchrones depuis fetchUncachedInBackground.
      getCachedRecommendations: jest.fn().mockResolvedValue([]),
      fetchAndCacheRecommendations: jest.fn().mockResolvedValue([]),
      // Mock de l'enrichissement community rating (par défaut : map vide)
      getCommunityRatings: jest.fn().mockResolvedValue(new Map()),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecommendationService,
        { provide: getRepositoryToken(UserManga), useValue: userMangaRepo },
        { provide: getRepositoryToken(MangaRecommendation), useValue: recoRepo },
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
        { provide: MangasService, useValue: mangasService },
      ],
    }).compile();

    service = module.get<RecommendationService>(RecommendationService);
  });

  it('utilise le fallback cold start si la bibliothèque est vide', async () => {
    userMangaRepo.find.mockResolvedValue([]);
    // Top communauté vide
    userMangaRepo.createQueryBuilder = jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    })) as any;
    // Sleepers vides aussi → résultat final vide
    mangaRepo.createQueryBuilder = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    })) as any;

    const result = await service.buildUserRecommendations(42);
    expect(result).toEqual([]);
    // Le scoring personnel n'est pas tenté quand la biblio est vide
    expect(mangasService.getCachedRecommendations).not.toHaveBeenCalled();
  });

  it('cold start: remonte le top communauté quand la biblio est vide', async () => {
    userMangaRepo.find.mockResolvedValue([]);
    // Top communauté : 2 mangas avec ≥ 5 votes locaux
    userMangaRepo.createQueryBuilder = jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { manga_id: '5000', avg: '9.0', count: '10' },
        { manga_id: '5001', avg: '8.5', count: '8' },
      ]),
    })) as any;

    mangaRepo.find.mockImplementation(({ where }) => {
      const ids = (where as any).mu_id._value;
      return Promise.resolve(
        ids.map((id: string) =>
          makeManga({ mu_id: id, title: `Manga ${id}` }),
        ),
      );
    });

    // Sleepers vides (focus sur top communauté pour ce test)
    mangaRepo.createQueryBuilder = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    })) as any;

    mangasService.getCommunityRatings.mockResolvedValue(
      new Map([
        [
          '5000',
          {
            communityRating: 9.0,
            communityRatingCount: 10,
            aggregatedRating: 7.75,
          },
        ],
        [
          '5001',
          {
            communityRating: 8.5,
            communityRatingCount: 8,
            aggregatedRating: 7.42,
          },
        ],
      ]),
    );

    const result = await service.buildUserRecommendations(42, 50, 0);
    expect(result).toHaveLength(2);
    // Triés par aggregatedRating desc : 5000 (7.75) avant 5001 (7.42)
    expect(result.map((r) => r.muId)).toEqual([5000, 5001]);
    // La pagination tape directement sur le pool sans passer par le scoring
    expect(mangasService.getCachedRecommendations).not.toHaveBeenCalled();
  });

  it('exclut les mangas déjà présents dans la bibliothèque', async () => {
    // L'utilisateur a déjà 1000 et 1001 dans sa bibliothèque
    userMangaRepo.find.mockResolvedValue([
      makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      makeUserManga({ id: 2, manga: makeManga({ id: 2, mu_id: '1001' }) }),
    ]);

    // Le manga source 1000 recommande 1001 (déjà en biblio) et 2000 (nouveau)
    mangasService.getCachedRecommendations.mockImplementation((muId: number) => {
      if (muId === 1000) {
        return Promise.resolve([
          makeReco('1000', '1001', 9, 'Already in lib'),
          makeReco('1000', '2000', 8, 'New manga'),
        ]);
      }
      return Promise.resolve([]);
    });

    mangaRepo.find.mockImplementation(({ where }) => {
      const targetIds = (where as any).mu_id._value;
      return Promise.resolve(
        targetIds.map((id: string) =>
          makeManga({
            mu_id: id,
            title: `Manga ${id}`,
            small_cover_url: `https://cdn/${id}-s.jpg`,
            medium_cover_url: `https://cdn/${id}-m.jpg`,
          }),
        ),
      );
    });

    const result = await service.buildUserRecommendations(42);
    expect(result).toHaveLength(1);
    expect(result[0].muId).toBe(2000);
    expect(result[0].title).toBe('Manga 2000');
    // mediumCoverUrl + largeCoverUrl pointent désormais sur medium_cover_url
    // (= image.url.original côté MU). small_cover_url (thumb) n'est plus
    // exposé car il rend flou sur mobile.
    expect(result[0].mediumCoverUrl).toBe('https://cdn/2000-m.jpg');
    expect(result[0].largeCoverUrl).toBe('https://cdn/2000-m.jpg');
  });

  it('limite à MAX_RECOS_PER_SOURCE pour la diversité', async () => {
    // 4 mangas en biblio, chacun avec 35 recos disjointes : pool initial = 4×30 = 120,
    // au-dessus de MIN_POOL_BEFORE_RELAX (50) donc le cap=30 reste appliqué.
    const userMangas = Array.from({ length: 4 }, (_, i) =>
      makeUserManga({
        id: i + 1,
        manga: makeManga({ id: i + 1, mu_id: String(1000 + i) }),
      }),
    );
    userMangaRepo.find.mockResolvedValue(userMangas);

    mangasService.getCachedRecommendations.mockImplementation(
      (muId: number) => {
        const base = (muId - 1000) * 100 + 2000;
        return Promise.resolve(
          Array.from({ length: 35 }, (_, i) =>
            makeReco(
              String(muId),
              String(base + i),
              35 - i,
              `Reco ${base + i}`,
            ),
          ),
        );
      },
    );

    mangaRepo.find.mockImplementation(({ where }) => {
      const ids = (where as any).mu_id._value;
      return Promise.resolve(
        ids.map((id: string) =>
          makeManga({ mu_id: id, title: `Manga ${id}` }),
        ),
      );
    });

    // limit=500 (=MAX_LIMIT) pour récupérer tous les candidats post-cap.
    const result = await service.buildUserRecommendations(42, 500, 0);
    // 4 sources × cap=30 = 120 candidats (recos disjointes)
    expect(result).toHaveLength(120);
    // Chaque source ne contribue que ses 30 meilleurs (poids 35..6),
    // ses 5 plus faibles (poids 5..1, muIds *30 à *34) sont tronquées.
    const muIds = new Set(result.map((r) => r.muId));
    expect(muIds.has(2029)).toBe(true); // Top 30 de la source 1000
    expect(muIds.has(2030)).toBe(false); // 31e reco de la source 1000 → tronquée
  });

  it("trie par score décroissant et applique offset + limit", async () => {
    userMangaRepo.find.mockResolvedValue([
      makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
    ]);

    // 4 recos avec poids 10, 7, 5, 3
    mangasService.getCachedRecommendations.mockResolvedValue([
      makeReco('1000', '2000', 10),
      makeReco('1000', '2001', 7),
      makeReco('1000', '2002', 5),
      makeReco('1000', '2003', 3),
    ]);

    mangaRepo.find.mockImplementation(({ where }) => {
      const ids = (where as any).mu_id._value;
      return Promise.resolve(
        ids.map((id: string) =>
          makeManga({ mu_id: id, title: `Manga ${id}` }),
        ),
      );
    });

    // Limit=2, offset=1 → on saute le top 1 et on prend les 2 suivants
    const result = await service.buildUserRecommendations(42, 2, 1);
    expect(result.map((r) => r.muId)).toEqual([2001, 2002]);
  });

  it('applique le multiplicateur de statut (completed > readLater)', async () => {
    // Deux mangas sources avec le même reco enfant 2000, mais statuts différents
    userMangaRepo.find.mockResolvedValue([
      makeUserManga({
        manga: makeManga({ mu_id: '1000' }),
        readingStatus: ReadingStatus.Completed,
      }),
      makeUserManga({
        id: 2,
        manga: makeManga({ id: 2, mu_id: '1001', title: 'M1001' }),
        readingStatus: ReadingStatus.ReadLater,
      }),
    ]);

    mangasService.getCachedRecommendations.mockImplementation((muId: number) => {
      if (muId === 1000) {
        return Promise.resolve([makeReco('1000', '2000', 10)]);
      }
      if (muId === 1001) {
        return Promise.resolve([makeReco('1001', '2001', 10)]);
      }
      return Promise.resolve([]);
    });

    mangaRepo.find.mockImplementation(({ where }) => {
      const ids = (where as any).mu_id._value;
      return Promise.resolve(
        ids.map((id: string) =>
          makeManga({ mu_id: id, title: `Manga ${id}` }),
        ),
      );
    });

    const result = await service.buildUserRecommendations(42);
    // 2000 (completed × 1.5) doit être devant 2001 (readLater × 0.8)
    expect(result.map((r) => r.muId)).toEqual([2000, 2001]);
  });

  it("populate recommendedBecauseOf avec le top des mangas sources", async () => {
    userMangaRepo.find.mockResolvedValue([
      makeUserManga({
        manga: makeManga({ mu_id: '1000', title: 'One Piece' }),
        readingStatus: ReadingStatus.Completed,
      }),
      makeUserManga({
        id: 2,
        manga: makeManga({ id: 2, mu_id: '1001', title: 'Naruto' }),
        readingStatus: ReadingStatus.Completed,
      }),
    ]);

    // Les deux sources recommandent 2000
    mangasService.getCachedRecommendations.mockImplementation((muId: number) => {
      if (muId === 1000) {
        return Promise.resolve([makeReco('1000', '2000', 9)]);
      }
      if (muId === 1001) {
        return Promise.resolve([makeReco('1001', '2000', 8)]);
      }
      return Promise.resolve([]);
    });

    mangaRepo.find.mockImplementation(({ where }) => {
      const ids = (where as any).mu_id._value;
      return Promise.resolve(
        ids.map((id: string) =>
          id === '2000'
            ? makeManga({ mu_id: id, title: 'Bleach' })
            : id === '1000'
              ? makeManga({ mu_id: id, title: 'One Piece' })
              : makeManga({ mu_id: id, title: 'Naruto' }),
        ),
      );
    });

    const result = await service.buildUserRecommendations(42);
    expect(result).toHaveLength(1);
    expect(result[0].muId).toBe(2000);
    expect(result[0].recommendedBecauseOf).toBeDefined();
    expect(result[0].recommendedBecauseOf).toContain('One Piece');
    expect(result[0].recommendedBecauseOf).toContain('Naruto');
  });

  it("fait un fetch MU bloquant si le cache est vide", async () => {
    userMangaRepo.find.mockResolvedValue([
      makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
    ]);
    mangasService.getCachedRecommendations.mockResolvedValue([]); // cache vide
    mangasService.fetchAndCacheRecommendations.mockResolvedValue([
      makeReco('1000', '2000', 10),
    ]);

    mangaRepo.find.mockImplementation(({ where }) => {
      const ids = (where as any).mu_id._value;
      return Promise.resolve(
        ids.map((id: string) =>
          makeManga({ mu_id: id, title: `Manga ${id}` }),
        ),
      );
    });

    const result = await service.buildUserRecommendations(42);
    expect(mangasService.fetchAndCacheRecommendations).toHaveBeenCalledWith(1000);
    expect(result).toHaveLength(1);
    expect(result[0].muId).toBe(2000);
  });

  it('ne crashe pas si fetchAndCacheRecommendations rejette', async () => {
    userMangaRepo.find.mockResolvedValue([
      makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
    ]);
    mangasService.getCachedRecommendations.mockResolvedValue([]);
    mangasService.fetchAndCacheRecommendations.mockRejectedValue(
      new Error('MU API down'),
    );

    const result = await service.buildUserRecommendations(42);
    expect(result).toEqual([]);
  });

  describe('genre filter', () => {
    function makeMangaWithGenres(
      mu_id: string,
      genres: string[],
      title?: string,
    ): Manga {
      return makeManga({
        mu_id,
        title: title ?? `Manga ${mu_id}`,
        genres,
      });
    }

    it('filtre les recommandations par genre exact (case-insensitive)', async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      ]);
      mangasService.getCachedRecommendations.mockResolvedValue([
        makeReco('1000', '2000', 10),
        makeReco('1000', '2001', 8),
        makeReco('1000', '2002', 5),
      ]);

      mangaRepo.find.mockImplementation(({ where }) => {
        const ids = (where as any).mu_id._value;
        return Promise.resolve(
          ids.map((id: string) => {
            const genres =
              id === '2000' ? ['Action'] :
              id === '2001' ? ['Romance'] :
              id === '2002' ? ['Action', 'Adventure'] :
              [];
            return makeMangaWithGenres(id, genres);
          }),
        );
      });

      const result = await service.buildUserRecommendations(42, 50, 0, 'action');
      expect(result.map((r) => r.muId).sort()).toEqual([2000, 2002]);
    });

    it("retourne [] si aucun manga ne match le genre filtré", async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      ]);
      mangasService.getCachedRecommendations.mockResolvedValue([
        makeReco('1000', '2000', 10),
      ]);
      mangaRepo.find.mockImplementation(() =>
        Promise.resolve([makeMangaWithGenres('2000', ['Romance'])]),
      );

      const result = await service.buildUserRecommendations(42, 50, 0, 'mecha');
      expect(result).toEqual([]);
    });
  });

  describe('buildUserRecommendationsByGenre', () => {
    function makeMangaWithGenres(
      mu_id: string,
      genres: string[],
      title?: string,
    ): Manga {
      return makeManga({
        mu_id,
        title: title ?? `Manga ${mu_id}`,
        genres,
      });
    }

    it("groupe les recommandations par genre, top N par section", async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      ]);
      mangasService.getCachedRecommendations.mockResolvedValue([
        makeReco('1000', '2000', 10),
        makeReco('1000', '2001', 9),
        makeReco('1000', '2002', 8),
        makeReco('1000', '2003', 7),
      ]);

      mangaRepo.find.mockImplementation(({ where }) => {
        const ids = (where as any).mu_id._value;
        return Promise.resolve(
          ids.map((id: string) => {
            const genres =
              id === '2000' ? ['Action'] :
              id === '2001' ? ['Action'] :
              id === '2002' ? ['Romance'] :
              id === '2003' ? ['Action', 'Romance'] :
              ['Misc'];
            return makeMangaWithGenres(id, genres, `Manga ${id}`);
          }),
        );
      });

      const result = await service.buildUserRecommendationsByGenre(42, 5, 10);
      expect(Object.keys(result).sort()).toEqual(['Action', 'Romance']);
      expect(result['Action'].length).toBe(3); // 2000, 2001, 2003
      expect(result['Romance'].length).toBe(2); // 2002, 2003
    });

    it("filtre les genres NSFW (Adult, Hentai, etc.)", async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      ]);
      mangasService.getCachedRecommendations.mockResolvedValue([
        makeReco('1000', '2000', 10),
      ]);
      mangaRepo.find.mockImplementation(() =>
        Promise.resolve([
          makeMangaWithGenres('2000', ['Action', 'Adult'], 'M2000'),
        ]),
      );

      const result = await service.buildUserRecommendationsByGenre(42, 5, 10);
      expect(Object.keys(result)).toEqual(['Action']);
      expect(result['Adult']).toBeUndefined();
    });

    it("retourne {} si la bibliothèque est vide", async () => {
      userMangaRepo.find.mockResolvedValue([]);
      const result = await service.buildUserRecommendationsByGenre(42);
      expect(result).toEqual({});
    });
  });

  describe('findSleeperHits', () => {
    const currentYear = new Date().getFullYear();

    function makeMangaForSleeper(
      mu_id: string,
      year: number,
      rating: number,
      title?: string,
    ): Manga {
      return makeManga({
        mu_id,
        year,
        rating,
        title: title ?? `Sleeper ${mu_id}`,
        small_cover_url: `https://cdn/${mu_id}-s.jpg`,
        medium_cover_url: `https://cdn/${mu_id}-m.jpg`,
      });
    }

    /**
     * Helper qui mocke le QueryBuilder pour `mangaRepository` (filtre
     * year/rating/exclude library) et `recoRepository` (count par mu_id).
     */
    function mockQueryBuilders(opts: {
      candidates: Manga[];
      recoCounts: Map<string, number>;
    }) {
      // Manga repo : QB pour candidats
      const mangaQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(opts.candidates),
      };
      mangaRepo.createQueryBuilder = jest.fn(() => mangaQb) as any;

      // Reco repo : QB pour count
      const recoQb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(
          Array.from(opts.recoCounts.entries()).map(([mu_id, count]) => ({
            mu_id,
            count: count.toString(),
          })),
        ),
      };
      recoRepo.createQueryBuilder = jest.fn(() => recoQb) as any;
    }

    it("retourne [] si aucun candidat (rating < 7.5 ou trop ancien)", async () => {
      userMangaRepo.find.mockResolvedValue([]);
      mockQueryBuilders({ candidates: [], recoCounts: new Map() });

      const result = await service.findSleeperHits(42, 20);
      expect(result).toEqual([]);
    });

    it('exclut les mangas déjà en bibliothèque', async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeMangaForSleeper('1000', currentYear, 8) }),
      ]);
      // Service : 1000 est filtré par le QueryBuilder (.andWhere('NOT IN'))
      // → on simule que getMany ne le retourne pas
      mockQueryBuilders({
        candidates: [makeMangaForSleeper('2000', currentYear, 8.5)],
        recoCounts: new Map(),
      });

      const result = await service.findSleeperHits(42, 20);
      expect(result).toHaveLength(1);
      expect(result[0].muId).toBe(2000);
    });

    it('exclut les mangas trop visibles (>= 5 occurrences dans manga_recommendation)', async () => {
      userMangaRepo.find.mockResolvedValue([]);
      mockQueryBuilders({
        candidates: [
          makeMangaForSleeper('2000', currentYear, 8.5),
          makeMangaForSleeper('2001', currentYear, 8.0),
        ],
        // 2000 = 10 recos (trop populaire) → exclu
        // 2001 = 2 recos (caché) → gardé
        recoCounts: new Map([
          ['2000', 10],
          ['2001', 2],
        ]),
      });

      const result = await service.findSleeperHits(42, 20);
      expect(result.map((r) => r.muId)).toEqual([2001]);
    });

    it("trie par score sleeper décroissant", async () => {
      userMangaRepo.find.mockResolvedValue([]);
      mockQueryBuilders({
        candidates: [
          makeMangaForSleeper('2000', currentYear, 7.5), // ancien (year=now), rating bas
          makeMangaForSleeper('2001', currentYear, 9.0), // récent, rating haut
        ],
        recoCounts: new Map(),
      });

      const result = await service.findSleeperHits(42, 20);
      // 2001 (rating 9.0) doit être devant 2000 (rating 7.5)
      expect(result.map((r) => r.muId)).toEqual([2001, 2000]);
    });

    it('mappe correctement les covers (small → medium, medium → large)', async () => {
      userMangaRepo.find.mockResolvedValue([]);
      mockQueryBuilders({
        candidates: [makeMangaForSleeper('2000', currentYear, 8.5)],
        recoCounts: new Map(),
      });

      const result = await service.findSleeperHits(42, 20);
      // mediumCoverUrl + largeCoverUrl pointent désormais tous deux sur
      // medium_cover_url (= image.url.original côté MU).
      expect(result[0].mediumCoverUrl).toBe('https://cdn/2000-m.jpg');
      expect(result[0].largeCoverUrl).toBe('https://cdn/2000-m.jpg');
    });
  });

  it('réponse rapide depuis le cache + fetch background pour les non-cachés', async () => {
    userMangaRepo.find.mockResolvedValue([
      makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      makeUserManga({
        id: 2,
        manga: makeManga({ id: 2, mu_id: '1001', title: 'Source 2' }),
      }),
    ]);

    // 1000 est en cache, 1001 non
    mangasService.getCachedRecommendations.mockImplementation((muId: number) =>
      Promise.resolve(
        muId === 1000 ? [makeReco('1000', '2000', 10)] : [],
      ),
    );
    mangasService.fetchAndCacheRecommendations.mockResolvedValue([]);

    mangaRepo.find.mockImplementation(({ where }) => {
      const ids = (where as any).mu_id._value;
      return Promise.resolve(
        ids.map((id: string) =>
          makeManga({ mu_id: id, title: `Manga ${id}` }),
        ),
      );
    });

    const result = await service.buildUserRecommendations(42);
    expect(result).toHaveLength(1);
    // Le fetch background est asynchrone — vérifier qu'il est lancé sans bloquer
    expect(mangasService.fetchAndCacheRecommendations).toHaveBeenCalledWith(1001);
  });
});
