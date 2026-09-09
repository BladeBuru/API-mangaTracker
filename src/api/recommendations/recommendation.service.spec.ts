import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RecommendationService } from './recommendation.service';
import { RecoCacheService } from './reco-cache.service';
import {
  CatalogCandidate,
  CatalogCandidateService,
} from './catalog-candidate.service';
import { GenreSectionService } from './genre-section.service';
import { DismissalService } from './dismissal.service';
import { SleeperHitsService } from './sleeper-hits.service';
import { RecoGraphCandidateService } from './reco-graph-candidate.service';
import { RecommendationDtoBuilderService } from './recommendation-dto-builder.service';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { MangasService } from '@/api/mangas/mangas.service';
import { MuRateLimitException } from '@/api/mangas/exceptions/mu-rate-limit.exception';
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
  /** Instance réelle — permet d'espionner le passage du set d'exclusion. */
  let genreSections: GenreSectionService;
  /** Instance réelle du cache — permet de le vider entre deux calculs. */
  let recoCache: RecoCacheService;
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
  let catalogCandidates: { findCandidates: jest.Mock };
  /**
   * Graphe de voisinage MU (`category` / `related`). Neutre par défaut : les
   * suites historiques doivent produire EXACTEMENT le même résultat qu'avant
   * son arrivée ; le describe dédié lui fait injecter des candidats.
   */
  let recoGraphCandidates: { augment: jest.Mock };
  /**
   * mu_id écartés par l'utilisateur (« pas intéressé / déjà vu »). Vide par
   * défaut : chaque test qui teste l'exclusion y ajoute ses ids.
   */
  let dismissedMuIds: Set<string>;
  let dismissals: {
    getDismissedMuIds: jest.Mock;
    buildExclusionSet: jest.Mock;
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
    // Catalogue local vide par défaut — les tests dédiés le peuplent.
    catalogCandidates = {
      findCandidates: jest.fn().mockResolvedValue([]),
    };
    recoGraphCandidates = { augment: jest.fn().mockResolvedValue(0) };
    // Double du DismissalService qui reproduit fidèlement l'union
    // « bibliothèque ∪ rejets » du vrai service (cf. buildExclusionSet).
    dismissedMuIds = new Set<string>();
    dismissals = {
      getDismissedMuIds: jest.fn(async () => new Set(dismissedMuIds)),
      buildExclusionSet: jest.fn(
        async (_userId: number, libraryMuIds: Iterable<string>) => {
          const excluded = new Set<string>(libraryMuIds);
          for (const muId of dismissedMuIds) excluded.add(muId);
          return excluded;
        },
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecommendationService,
        // Instance réelle (in-memory pur) — recréée à chaque test par le
        // beforeEach, donc pas de fuite de cache entre les cas.
        RecoCacheService,
        // Instance réelle — consomme les mêmes mocks repo/MangasService.
        GenreSectionService,
        // Instances réelles (extraites le 2026-09-05) — sleepers/cold start
        // et construction des cartes, sur les mêmes mocks.
        SleeperHitsService,
        RecommendationDtoBuilderService,
        { provide: getRepositoryToken(UserManga), useValue: userMangaRepo },
        {
          provide: getRepositoryToken(MangaRecommendation),
          useValue: recoRepo,
        },
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
        { provide: MangasService, useValue: mangasService },
        { provide: CatalogCandidateService, useValue: catalogCandidates },
        {
          provide: RecoGraphCandidateService,
          useValue: recoGraphCandidates,
        },
        { provide: DismissalService, useValue: dismissals },
      ],
    }).compile();

    service = module.get<RecommendationService>(RecommendationService);
    genreSections = module.get<GenreSectionService>(GenreSectionService);
    recoCache = module.get<RecoCacheService>(RecoCacheService);
    // Neutralise les pauses inter-batch (batch délai/429 testés dédiés).
    service.sleep = jest.fn().mockResolvedValue(undefined);
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
      addOrderBy: jest.fn().mockReturnThis(),
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
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { manga_id: '5000', avg: '9.0', count: '10' },
        { manga_id: '5001', avg: '8.5', count: '8' },
      ]),
    })) as any;

    mangaRepo.find.mockImplementation(({ where }) => {
      const ids = (where as any).mu_id._value;
      return Promise.resolve(
        ids.map((id: string) => makeManga({ mu_id: id, title: `Manga ${id}` })),
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
    mangasService.getCachedRecommendations.mockImplementation(
      (muId: number) => {
        if (muId === 1000) {
          return Promise.resolve([
            makeReco('1000', '1001', 9, 'Already in lib'),
            makeReco('1000', '2000', 8, 'New manga'),
          ]);
        }
        return Promise.resolve([]);
      },
    );

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

  it('limite à MAX_RECOS_PER_SOURCE pour la diversité (pool ≥ 150 → catalogue non sollicité)', async () => {
    // 4 mangas en biblio, chacun avec 45 recos disjointes : pool = 4×40 = 160,
    // au-dessus de CATALOG_MIN_POOL (150) donc le catalogue local n'est pas
    // interrogé et le cap=40 par source reste appliqué.
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
          Array.from({ length: 45 }, (_, i) =>
            makeReco(
              String(muId),
              String(base + i),
              45 - i,
              `Reco ${base + i}`,
            ),
          ),
        );
      },
    );

    mangaRepo.find.mockImplementation(({ where }) => {
      const ids = (where as any).mu_id._value;
      return Promise.resolve(
        ids.map((id: string) => makeManga({ mu_id: id, title: `Manga ${id}` })),
      );
    });

    // limit=500 (=MAX_LIMIT) pour récupérer tous les candidats post-cap.
    const result = await service.buildUserRecommendations(42, 500, 0);
    // 4 sources × cap=40 = 160 candidats (recos disjointes)
    expect(result).toHaveLength(160);
    // Chaque source ne contribue que ses 40 meilleurs (poids 45..6),
    // ses 5 plus faibles (poids 5..1, muIds *40 à *44) sont tronquées.
    const muIds = new Set(result.map((r) => r.muId));
    expect(muIds.has(2039)).toBe(true); // Top 40 de la source 1000
    expect(muIds.has(2040)).toBe(false); // 41e reco de la source 1000 → tronquée
    // Seuil : pool (160) ≥ CATALOG_MIN_POOL (150) → catalogue non appelé.
    expect(catalogCandidates.findCandidates).not.toHaveBeenCalled();
  });

  it('sert les recos depuis le cache user-level au 2e appel (US-4)', async () => {
    userMangaRepo.find.mockResolvedValue([
      makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
    ]);
    mangasService.getCachedRecommendations.mockResolvedValue([
      makeReco('1000', '2000', 10),
    ]);
    mangaRepo.find.mockImplementation(({ where }) => {
      const ids = (where as any).mu_id._value;
      return Promise.resolve(
        ids.map((id: string) => makeManga({ mu_id: id, title: `Manga ${id}` })),
      );
    });

    const first = await service.buildUserRecommendations(42, 50, 0);
    const second = await service.buildUserRecommendations(42, 50, 0);

    expect(second).toEqual(first);
    // Un seul passage dans le pipeline de scoring : le 2e appel = cache hit.
    expect(userMangaRepo.find).toHaveBeenCalledTimes(1);
  });

  it('trie par score décroissant et applique offset + limit', async () => {
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
        ids.map((id: string) => makeManga({ mu_id: id, title: `Manga ${id}` })),
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

    mangasService.getCachedRecommendations.mockImplementation(
      (muId: number) => {
        if (muId === 1000) {
          return Promise.resolve([makeReco('1000', '2000', 10)]);
        }
        if (muId === 1001) {
          return Promise.resolve([makeReco('1001', '2001', 10)]);
        }
        return Promise.resolve([]);
      },
    );

    mangaRepo.find.mockImplementation(({ where }) => {
      const ids = (where as any).mu_id._value;
      return Promise.resolve(
        ids.map((id: string) => makeManga({ mu_id: id, title: `Manga ${id}` })),
      );
    });

    const result = await service.buildUserRecommendations(42);
    // 2000 (completed × 1.5) doit être devant 2001 (readLater × 0.8)
    expect(result.map((r) => r.muId)).toEqual([2000, 2001]);
  });

  it('populate recommendedBecauseOf avec le top des mangas sources', async () => {
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
    mangasService.getCachedRecommendations.mockImplementation(
      (muId: number) => {
        if (muId === 1000) {
          return Promise.resolve([makeReco('1000', '2000', 9)]);
        }
        if (muId === 1001) {
          return Promise.resolve([makeReco('1001', '2000', 8)]);
        }
        return Promise.resolve([]);
      },
    );

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

  it('fait un fetch MU bloquant si le cache est vide', async () => {
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
        ids.map((id: string) => makeManga({ mu_id: id, title: `Manga ${id}` })),
      );
    });

    const result = await service.buildUserRecommendations(42);
    expect(mangasService.fetchAndCacheRecommendations).toHaveBeenCalledWith(
      1000,
    );
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
              id === '2000'
                ? ['Action']
                : id === '2001'
                ? ['Romance']
                : id === '2002'
                ? ['Action', 'Adventure']
                : [];
            return makeMangaWithGenres(id, genres);
          }),
        );
      });

      const result = await service.buildUserRecommendations(
        42,
        50,
        0,
        'action',
      );
      expect(result.map((r) => r.muId).sort()).toEqual([2000, 2002]);
    });

    it('retourne [] si aucun manga ne match le genre filtré', async () => {
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

    /**
     * QB catalogue (complément des sections déficitaires) — vide par défaut.
     * Le complément lui-même est testé en détail dans
     * `genre-section.service.spec.ts`.
     */
    function mockEmptyCatalogQb() {
      mangaRepo.createQueryBuilder = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })) as any;
    }

    it('groupe par genre avec exclusivité : un manga ne sort que dans la section de son genre le mieux classé', async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      ]);
      mockEmptyCatalogQb();
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
              id === '2000'
                ? ['Action']
                : id === '2001'
                ? ['Action']
                : id === '2002'
                ? ['Romance']
                : id === '2003'
                ? ['Action', 'Romance']
                : ['Misc'];
            return makeMangaWithGenres(id, genres, `Manga ${id}`);
          }),
        );
      });

      const result = await service.buildUserRecommendationsByGenre(42, 5, 10);
      expect(Object.keys(result).sort()).toEqual(['Action', 'Romance']);
      // 2003 (Action + Romance) n'apparaît QUE dans Action (genre le mieux
      // classé) — avant le fix il était dupliqué dans les deux sections.
      expect(result['Action'].map((d) => d.muId)).toEqual([2000, 2001, 2003]);
      expect(result['Romance'].map((d) => d.muId)).toEqual([2002]);
      // Aucun muId ne doit apparaître dans plus d'une section.
      const all = Object.values(result).flatMap((l) => l.map((d) => d.muId));
      expect(new Set(all).size).toBe(all.length);
    });

    it('filtre les genres NSFW (Adult, Hentai, etc.)', async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      ]);
      mockEmptyCatalogQb();
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

    it('retourne {} si la bibliothèque est vide', async () => {
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

    it('retourne [] si aucun candidat (rating < 7.5 ou trop ancien)', async () => {
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

    it('trie par score sleeper décroissant', async () => {
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
      Promise.resolve(muId === 1000 ? [makeReco('1000', '2000', 10)] : []),
    );
    mangasService.fetchAndCacheRecommendations.mockResolvedValue([]);

    mangaRepo.find.mockImplementation(({ where }) => {
      const ids = (where as any).mu_id._value;
      return Promise.resolve(
        ids.map((id: string) => makeManga({ mu_id: id, title: `Manga ${id}` })),
      );
    });

    const result = await service.buildUserRecommendations(42);
    expect(result).toHaveLength(1);
    // Le fetch background est asynchrone — vérifier qu'il est lancé sans bloquer
    expect(mangasService.fetchAndCacheRecommendations).toHaveBeenCalledWith(
      1001,
    );
  });

  describe('catalogue local (CATALOG_MIN_POOL)', () => {
    function makeCandidate(
      mu_id: string,
      score: number,
      sourceMuIds: string[] = ['1000'],
    ): CatalogCandidate {
      return { mu_id, score, sourceMuIds, type: null };
    }

    it('fusionne les candidats catalogue sous le seuil : tri global, MU prime (pas d’addition), biblio exclue', async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      ]);
      // 3 recos MU en cache — scores ≈ weight × 1.2 (reading récent).
      mangasService.getCachedRecommendations.mockResolvedValue([
        makeReco('1000', '2000', 10),
        makeReco('1000', '2001', 7),
        makeReco('1000', '2002', 5),
      ]);
      // Catalogue : 1 nouveau candidat, 1 collision avec une reco MU (2002,
      // score volontairement énorme), 1 candidat déjà en biblio (1000).
      catalogCandidates.findCandidates.mockResolvedValue([
        makeCandidate('3000', 4.5, ['1000']),
        makeCandidate('2002', 999),
        makeCandidate('1000', 999),
      ]);
      mangaRepo.find.mockImplementation(({ where }) => {
        const ids = (where as any).mu_id._value;
        return Promise.resolve(
          ids.map((id: string) =>
            makeManga({ mu_id: id, title: `Manga ${id}` }),
          ),
        );
      });

      const result = await service.buildUserRecommendations(42, 50, 0);

      // findCandidates reçoit la biblio en exclusion stricte.
      expect(catalogCandidates.findCandidates).toHaveBeenCalledTimes(1);
      const excludeArg = catalogCandidates.findCandidates.mock
        .calls[0][1] as Set<string>;
      expect(excludeArg.has('1000')).toBe(true);

      const ids = result.map((r) => r.muId);
      // Biblio exclue même si le catalogue la propose.
      expect(ids).not.toContain(1000);
      // Fusion triée : le candidat catalogue s'intercale selon son score et
      // 2002 GARDE son score MU (une addition/écrasement le mettrait en tête).
      expect(ids).toEqual([2000, 2001, 2002, 3000]);
      // Explicabilité : recommendedBecauseOf depuis sourceMuIds.
      const dto3000 = result.find((r) => r.muId === 3000);
      expect(dto3000!.recommendedBecauseOf).toContain('Manga 1000');
    });

    it('ne sollicite pas le catalogue quand le pool MU atteint le seuil (voir test MAX_RECOS_PER_SOURCE)', async () => {
      // Pool vide + biblio vide → cold start, catalogue jamais consulté.
      userMangaRepo.find.mockResolvedValue([]);
      userMangaRepo.createQueryBuilder = jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        having: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      })) as any;
      mangaRepo.createQueryBuilder = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })) as any;

      await service.buildUserRecommendations(42);
      expect(catalogCandidates.findCandidates).not.toHaveBeenCalled();
    });

    it('by-genre bénéficie aussi du complément catalogue (via computeScoreMap)', async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      ]);
      // QB du complément par section (GenreSectionService) — vide ici, le
      // complément dédié est couvert par genre-section.service.spec.ts.
      mangaRepo.createQueryBuilder = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })) as any;
      mangasService.getCachedRecommendations.mockResolvedValue([
        makeReco('1000', '2000', 10),
      ]);
      catalogCandidates.findCandidates.mockResolvedValue([
        makeCandidate('3000', 4.5, ['1000']),
      ]);
      mangaRepo.find.mockImplementation(({ where }) => {
        const ids = (where as any).mu_id._value;
        return Promise.resolve(
          ids.map((id: string) =>
            makeManga({ mu_id: id, title: `Manga ${id}`, genres: ['Action'] }),
          ),
        );
      });

      const result = await service.buildUserRecommendationsByGenre(42, 5, 10);
      expect(catalogCandidates.findCandidates).toHaveBeenCalledTimes(1);
      expect(result['Action'].map((d) => d.muId)).toEqual([2000, 3000]);
    });
  });

  describe('fetch bloquant batché (délai / 429)', () => {
    function makeLibrary(size: number): UserManga[] {
      return Array.from({ length: size }, (_, i) =>
        makeUserManga({
          id: i + 1,
          manga: makeManga({ id: i + 1, mu_id: String(1000 + i) }),
        }),
      );
    }

    beforeEach(() => {
      mangasService.getCachedRecommendations.mockResolvedValue([]);
      mangaRepo.find.mockImplementation(({ where }) => {
        const ids = (where as any).mu_id._value;
        return Promise.resolve(
          ids.map((id: string) =>
            makeManga({ mu_id: id, title: `Manga ${id}` }),
          ),
        );
      });
    });

    it('pause 1 s entre deux batches de 5 fetches MU', async () => {
      userMangaRepo.find.mockResolvedValue(makeLibrary(10));
      mangasService.fetchAndCacheRecommendations.mockImplementation(
        (muId: number) =>
          Promise.resolve([makeReco(String(muId), String(muId + 1000), 5)]),
      );
      const sleepSpy = jest.fn().mockResolvedValue(undefined);
      service.sleep = sleepSpy;

      await service.buildUserRecommendations(42, 50, 0);

      // 10 mangas → 2 batches de 5 → une seule pause, de 1000 ms.
      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(sleepSpy).toHaveBeenCalledWith(1000);
    });

    it('MuRateLimitException (429) dans un batch → pause 5 s avant le batch suivant', async () => {
      userMangaRepo.find.mockResolvedValue(makeLibrary(10));
      mangasService.fetchAndCacheRecommendations.mockImplementation(
        (muId: number) => {
          // Tout le 1er batch (1000-1004) est rate-limité.
          if (muId < 1005) {
            return Promise.reject(new MuRateLimitException(muId));
          }
          return Promise.resolve([
            makeReco(String(muId), String(muId + 1000), 5),
          ]);
        },
      );
      const sleepSpy = jest.fn().mockResolvedValue(undefined);
      service.sleep = sleepSpy;

      const result = await service.buildUserRecommendations(42, 50, 0);

      expect(sleepSpy).toHaveBeenCalledTimes(1);
      expect(sleepSpy).toHaveBeenCalledWith(5000);
      // Le 2e batch a été traité malgré le 429 du 1er.
      expect(mangasService.fetchAndCacheRecommendations).toHaveBeenCalledWith(
        1009,
      );
      expect(result.map((r) => r.muId)).toEqual(
        expect.arrayContaining([2005, 2006, 2007, 2008, 2009]),
      );
    });
  });
  /**
   * Feature « pas intéressé / déjà vu ».
   *
   * Un titre écarté ne doit plus JAMAIS remonter — quel que soit le chemin.
   * Ces tests couvrent les chemins un par un : le risque principal de la
   * feature est d'en oublier un.
   */
  describe('exclusion des titres écartés (« pas intéressé / déjà vu »)', () => {
    it('liste plate : un titre écarté ne remonte plus, même recommandé fortement', async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      ]);
      // 2001 est LA reco la plus forte — c'est le cas « One Piece » : le
      // meilleur candidat de l'algo, et pourtant l'user n'en veut pas.
      mangasService.getCachedRecommendations.mockResolvedValue([
        makeReco('1000', '2001', 100, 'Deja vu en anime'),
        makeReco('1000', '2000', 5, 'A decouvrir'),
      ]);
      mangaRepo.find.mockImplementation(({ where }) => {
        const ids = (where as any).mu_id._value;
        return Promise.resolve(
          ids.map((id: string) =>
            makeManga({ mu_id: id, title: `Manga ${id}` }),
          ),
        );
      });

      dismissedMuIds.add('2001');
      const result = await service.buildUserRecommendations(42);

      expect(result.map((r) => r.muId)).toEqual([2000]);
    });

    it('candidats catalogue : le set d exclusion transmis contient biblio ET rejets', async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      ]);
      mangasService.getCachedRecommendations.mockResolvedValue([
        makeReco('1000', '2000', 10),
      ]);
      // Le catalogue re-propose le titre écarté : il doit être filtré même
      // si `findCandidates` était complaisant.
      catalogCandidates.findCandidates.mockResolvedValue([
        { mu_id: '3000', score: 4.5, sourceMuIds: ['1000'] },
        { mu_id: '2001', score: 999, sourceMuIds: ['1000'] },
      ]);
      mangaRepo.find.mockImplementation(({ where }) => {
        const ids = (where as any).mu_id._value;
        return Promise.resolve(
          ids.map((id: string) =>
            makeManga({ mu_id: id, title: `Manga ${id}` }),
          ),
        );
      });

      dismissedMuIds.add('2001');
      const result = await service.buildUserRecommendations(42);

      const excludeArg = catalogCandidates.findCandidates.mock
        .calls[0][1] as Set<string>;
      expect(excludeArg.has('1000')).toBe(true); // biblio
      expect(excludeArg.has('2001')).toBe(true); // rejet
      // Défense en profondeur : filtré même si le catalogue le renvoie.
      expect(result.map((r) => r.muId)).not.toContain(2001);
    });

    it('sections par genre : le set d exclusion est transmis a GenreSectionService', async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      ]);
      mangasService.getCachedRecommendations.mockResolvedValue([
        makeReco('1000', '2000', 10),
      ]);
      mangaRepo.find.mockResolvedValue([
        makeManga({ mu_id: '2000', genres: ['Action'] }),
      ]);
      const spy = jest
        .spyOn(genreSections, 'buildSections')
        .mockResolvedValue({});

      dismissedMuIds.add('2001');
      await service.buildUserRecommendationsByGenre(42, 5, 10);

      // 5e argument = biblio ∪ rejets. Sans lui, GenreSectionService
      // reconstruirait une exclusion « biblio seule » et ses compléments
      // catalogue pourraient réintroduire un titre écarté.
      const excludeArg = spy.mock.calls[0][4];
      expect(excludeArg.has('1000')).toBe(true);
      expect(excludeArg.has('2001')).toBe(true);
    });

    it('sleepers : les titres écartés partent dans le NOT IN de la requête', async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1000' }) }),
      ]);
      const mangaQb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      mangaRepo.createQueryBuilder = jest.fn(() => mangaQb) as any;

      dismissedMuIds.add('2001');
      await service.findSleeperHits(42, 20);

      const notInCall = mangaQb.andWhere.mock.calls.find(([sql]) =>
        (sql as string).includes('NOT IN'),
      );
      expect(notInCall).toBeDefined();
      expect((notInCall![1] as { lib: string[] }).lib).toEqual(
        expect.arrayContaining(['1000', '2001']),
      );
    });

    it('cold start : un titre écarté est exclu du top communauté (biblio vide)', async () => {
      // Bibliothèque vide ne veut pas dire « rien à exclure » : c'est même
      // le cas d'usage fondateur — l'user écarte One Piece avant d'avoir
      // ajouté quoi que ce soit.
      userMangaRepo.find.mockResolvedValue([]);
      userMangaRepo.createQueryBuilder = jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        having: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
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
      // Sleepers vides — on isole le top communauté.
      mangaRepo.createQueryBuilder = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })) as any;
      mangasService.getCommunityRatings.mockResolvedValue(new Map());

      dismissedMuIds.add('5000');
      const result = await service.buildUserRecommendations(42, 50, 0);

      expect(result.map((r) => r.muId)).toEqual([5001]);
    });

    it('cold start : les rejets du vrai userId sont chargés (et non la sentinelle -1)', async () => {
      userMangaRepo.find.mockResolvedValue([]);
      userMangaRepo.createQueryBuilder = jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        having: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      })) as any;
      mangaRepo.createQueryBuilder = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })) as any;

      await service.buildUserRecommendations(42, 50, 0);

      // Avant la feature, le cold start appelait findSleeperHits(-1) : les
      // rejets de l'utilisateur n'auraient jamais été chargés.
      expect(dismissals.getDismissedMuIds).toHaveBeenCalledWith(42);
      expect(dismissals.getDismissedMuIds).not.toHaveBeenCalledWith(-1);
    });
  });

  describe('type de publication (manga / manhwa / manhua)', () => {
    /** Types déduits de l'id : 3xxx = Manhwa, sinon Manga. */
    function typeOf(id: string): string {
      return id.startsWith('3') ? 'Manhwa' : 'Manga';
    }

    beforeEach(() => {
      mangaRepo.find.mockImplementation(({ where }) => {
        const ids = (where as any).mu_id._value as string[];
        return Promise.resolve(
          ids.map((id) =>
            makeManga({ mu_id: id, title: `Manga ${id}`, type: typeOf(id) }),
          ),
        );
      });
    });

    it('liste plate : un lecteur à 80 % manhwa reçoit ≈ 80 % de manhwa malgré des recos manga mieux scorées', async () => {
      // Bibliothèque : 4 manhwa + 1 manga (tous « reading »).
      userMangaRepo.find.mockResolvedValue([
        ...['1001', '1002', '1003', '1004'].map((id, i) =>
          makeUserManga({
            id: i + 1,
            manga: makeManga({ id: i + 1, mu_id: id, type: 'Manhwa' }),
          }),
        ),
        makeUserManga({
          id: 9,
          manga: makeManga({ id: 9, mu_id: '1005', type: 'Manga' }),
        }),
      ]);
      // Chaque source recommande 10 mangas (poids 20) et 10 manhwa (poids 5)
      // → les mangas dominent TOUT le haut du classement par score.
      mangasService.getCachedRecommendations.mockImplementation(
        (muId: number) =>
          Promise.resolve([
            ...Array.from({ length: 10 }, (_, i) =>
              makeReco(String(muId), `${2000 + i}`, 20),
            ),
            ...Array.from({ length: 10 }, (_, i) =>
              makeReco(String(muId), `${3000 + i}`, 5),
            ),
          ]),
      );

      const result = await service.buildUserRecommendations(42, 10, 0);

      expect(result).toHaveLength(10);
      expect(result[0].type).toBe('Manhwa');
      expect(result.filter((r) => r.type === 'Manhwa')).toHaveLength(8);
      expect(result.filter((r) => r.type === 'Manga')).toHaveLength(2);
      // Page 2 : prolonge sans doublon (ordre global déterministe).
      const page2 = await service.buildUserRecommendations(42, 10, 10);
      const all = [...result, ...page2].map((r) => r.muId);
      expect(new Set(all).size).toBe(all.length);
      expect(page2.filter((r) => r.type === 'Manhwa')).toHaveLength(2);
    });

    it('sleepers : la sélection respecte le profil de type de la bibliothèque', async () => {
      const currentYear = new Date().getFullYear();
      userMangaRepo.find.mockResolvedValue(
        ['1001', '1002', '1003'].map((id, i) =>
          makeUserManga({
            id: i + 1,
            manga: makeManga({ id: i + 1, mu_id: id, type: 'Manhwa' }),
          }),
        ),
      );
      // Candidats : 5 mangas notés 9, 5 manhwa notés 8 → sans prorata, les
      // mangas occupent tout le top 5.
      const candidates = [
        ...Array.from({ length: 5 }, (_, i) =>
          makeManga({
            mu_id: `${2000 + i}`,
            year: currentYear,
            rating: 9,
            type: 'Manga',
          }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          makeManga({
            mu_id: `${3000 + i}`,
            year: currentYear,
            rating: 8,
            type: 'Manhwa',
          }),
        ),
      ];
      mangaRepo.createQueryBuilder = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(candidates),
      })) as any;
      recoRepo.createQueryBuilder = jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      })) as any;

      const result = await service.findSleeperHits(42, 5);

      expect(result).toHaveLength(5);
      expect(result[0].type).toBe('Manhwa');
      // 100 % manhwa au profil + 5 % de découverte → au moins 4 manhwa sur 5.
      expect(
        result.filter((r) => r.type === 'Manhwa').length,
      ).toBeGreaterThanOrEqual(4);
    });

    it('bibliothèque sans type connu : ordre par score pur (comportement historique)', async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1001', type: null }) }),
      ]);
      mangasService.getCachedRecommendations.mockResolvedValue([
        makeReco('1001', '2000', 20),
        makeReco('1001', '3000', 5),
      ]);

      const result = await service.buildUserRecommendations(42, 2, 0);

      expect(result.map((r) => r.muId)).toEqual([2000, 3000]);
    });
  });
  /**
   * Graphe de voisinage MangaUpdates (`category` / `related`) — 2026-09-09.
   *
   * Le prorata de type introduit le 2026-09-05 ne peut rééquilibrer que ce
   * qui EXISTE dans le pool : quand les seuls liens disponibles ciblent des
   * mangas (84 % des 17 825 liens `manual` en prod), un lecteur de manhwa
   * reçoit des mangas quoi qu'il arrive. Ces tests vérifient les deux faces
   * du problème.
   */
  describe('graphe de voisinage MangaUpdates', () => {
    /** Types déduits de l'id : 3xxx = Manhwa, sinon Manga. */
    function typeOf(id: string): string {
      return id.startsWith('3') ? 'Manhwa' : 'Manga';
    }

    /** Bibliothèque 4 manhwa + 1 manga, dont les recos manuelles sont manga. */
    function libraryOfManhwaReader(): void {
      userMangaRepo.find.mockResolvedValue([
        ...['1001', '1002', '1003', '1004'].map((id, i) =>
          makeUserManga({
            id: i + 1,
            manga: makeManga({ id: i + 1, mu_id: id, type: 'Manhwa' }),
          }),
        ),
        makeUserManga({
          id: 9,
          manga: makeManga({ id: 9, mu_id: '1005', type: 'Manga' }),
        }),
      ]);
      mangasService.getCachedRecommendations.mockImplementation(
        (muId: number) =>
          Promise.resolve(
            Array.from({ length: 10 }, (_, i) =>
              makeReco(String(muId), `${2000 + i}`, 20),
            ),
          ),
      );
    }

    beforeEach(() => {
      mangaRepo.find.mockImplementation(({ where }) => {
        const ids = (where as any).mu_id._value as string[];
        return Promise.resolve(
          ids.map((id) =>
            makeManga({ mu_id: id, title: `Manga ${id}`, type: typeOf(id) }),
          ),
        );
      });
    });

    it('AVANT : sans candidats manhwa dans le pool, le prorata ne peut rien faire', async () => {
      libraryOfManhwaReader();

      const result = await service.buildUserRecommendations(42, 10, 0);

      expect(result).toHaveLength(10);
      expect(result.every((r) => r.type === 'Manga')).toBe(true);
    });

    it('APRÈS : les voisins du graphe entrent dans le pool et le prorata s’applique', async () => {
      libraryOfManhwaReader();
      // Le vrai service écrit dans le scoreMap ; on reproduit son effet.
      recoGraphCandidates.augment.mockImplementation(
        async (
          _userMangas: unknown,
          _excluded: Set<string>,
          scoreMap: Map<
            string,
            { score: number; sources: Map<string, number> }
          >,
        ) => {
          for (let i = 0; i < 10; i++) {
            scoreMap.set(`${3000 + i}`, {
              score: 30 - i,
              sources: new Map([['1001', 30 - i]]),
            });
          }
          return 10;
        },
      );

      const result = await service.buildUserRecommendations(42, 10, 0);

      expect(result[0].type).toBe('Manhwa');
      expect(result.filter((r) => r.type === 'Manhwa')).toHaveLength(8);
      expect(result.filter((r) => r.type === 'Manga')).toHaveLength(2);
    });

    it('reçoit le set d’exclusion complet (bibliothèque ∪ titres écartés)', async () => {
      libraryOfManhwaReader();
      dismissedMuIds = new Set(['2000']);

      await service.buildUserRecommendations(42, 10, 0);

      const excluded = recoGraphCandidates.augment.mock
        .calls[0][1] as Set<string>;
      expect(excluded.has('2000')).toBe(true);
      expect(excluded.has('1001')).toBe(true);
    });

    it('évite le fetch MU bloquant quand le graphe suffit à peupler le pool', async () => {
      userMangaRepo.find.mockResolvedValue([
        makeUserManga({ manga: makeManga({ mu_id: '1001', type: 'Manhwa' }) }),
      ]);
      // Aucun lien manuel en cache : avant le graphe, on partait en fetch
      // bloquant de toutes les fiches MU avant de répondre.
      mangasService.getCachedRecommendations.mockResolvedValue([]);
      recoGraphCandidates.augment.mockImplementation(
        async (
          _userMangas: unknown,
          _excluded: Set<string>,
          scoreMap: Map<
            string,
            { score: number; sources: Map<string, number> }
          >,
        ) => {
          scoreMap.set('3000', { score: 30, sources: new Map([['1001', 30]]) });
          return 1;
        },
      );

      // Le fetch MU ne se dénoue jamais : si la réponse en dépendait, cet
      // `await` resterait bloqué jusqu'au timeout du test.
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      mangasService.fetchAndCacheRecommendations.mockImplementation(
        async () => {
          await gate;
          return [];
        },
      );

      const result = await service.buildUserRecommendations(42, 10, 0);

      expect(result.map((r) => r.muId)).toEqual([3000]);
      // Le rattrapage du cache manuel a bien été lancé, mais en arrière-plan.
      expect(mangasService.fetchAndCacheRecommendations).toHaveBeenCalledWith(
        1001,
      );
      release();
    });

    it('alimente aussi la home segmentée par genre', async () => {
      libraryOfManhwaReader();
      recoGraphCandidates.augment.mockResolvedValue(0);

      await service.buildUserRecommendationsByGenre(42, 3, 5);

      expect(recoGraphCandidates.augment).toHaveBeenCalled();
    });
  });
  /**
   * Bug prod rapporté le 2026-09-09 : « les recommandations de la page
   * d'accueil, une fois que je déplie, ne sont pas forcément les mêmes dans
   * l'ordre ». L'accueil demande `limit=10`, « Voir tout » `limit=50`.
   */
  describe("stabilité de l'ordre (fix 2026-09-09)", () => {
    /** Deux titres sources, 14 candidats, tous les poids EX ÆQUO. */
    function setupTiedPool(reversed = false): void {
      const sources = ['1000', '1001'];
      const library = sources.map((muId, index) =>
        makeUserManga({
          id: index + 1,
          manga: makeManga({ id: index + 1, mu_id: muId }),
        }),
      );
      userMangaRepo.find.mockResolvedValue(
        reversed ? [...library].reverse() : library,
      );

      // 14 candidats de mu_id 2001..2014, TOUS au même poids : seul le
      // départage secondaire peut décider de l'ordre.
      const candidateIds = Array.from({ length: 14 }, (_, i) =>
        String(2001 + i),
      );
      mangasService.getCachedRecommendations.mockImplementation(
        async (muId: number) => {
          const recos = candidateIds.map((id) =>
            makeReco(String(muId), id, 10, `Titre ${id}`),
          );
          return reversed ? recos.reverse() : recos;
        },
      );

      mangaRepo.find.mockImplementation(({ where }: any) => {
        const ids: string[] = where.mu_id._value;
        const rows = ids.map((id) =>
          makeManga({ mu_id: id, title: `Titre ${id}` }),
        );
        return Promise.resolve(reversed ? rows.reverse() : rows);
      });
    }

    it('limit=10 est exactement le préfixe de limit=50 pour le même utilisateur', async () => {
      setupTiedPool();

      const home = await service.buildUserRecommendations(7, 10, 0);
      const seeAll = await service.buildUserRecommendations(7, 50, 0);

      expect(home).toHaveLength(10);
      expect(seeAll).toHaveLength(14);
      expect(seeAll.slice(0, 10).map((d) => d.muId)).toEqual(
        home.map((d) => d.muId),
      );
    });

    it('ne recalcule plus une liste par taille de page (limit/offset hors clé de cache)', async () => {
      setupTiedPool();

      await service.buildUserRecommendations(7, 10, 0);
      const callsAfterFirst =
        mangasService.getCachedRecommendations.mock.calls.length;
      await service.buildUserRecommendations(7, 50, 0);
      await service.buildUserRecommendations(7, 50, 10);

      // Un seul calcul : les deux autres appels ne font que trancher.
      expect(mangasService.getCachedRecommendations.mock.calls.length).toBe(
        callsAfterFirst,
      );
    });

    it('les pages successives se recollent sans trou ni doublon', async () => {
      setupTiedPool();

      const full = await service.buildUserRecommendations(7, 50, 0);
      const page1 = await service.buildUserRecommendations(7, 5, 0);
      const page2 = await service.buildUserRecommendations(7, 5, 5);

      expect([...page1, ...page2].map((d) => d.muId)).toEqual(
        full.slice(0, 10).map((d) => d.muId),
      );
    });

    it('départage les scores ex æquo par mu_id croissant', async () => {
      setupTiedPool();

      const result = await service.buildUserRecommendations(7, 50, 0);

      expect(result.map((d) => d.muId)).toEqual(
        Array.from({ length: 14 }, (_, i) => 2001 + i),
      );
    });

    it("rend le même ordre à deux calculs successifs, cache vidé et lignes dans l'ordre inverse", async () => {
      setupTiedPool();
      const first = await service.buildUserRecommendations(7, 50, 0);

      // Le cache est vidé (mutation de bibliothèque, TTL…) et la base rend
      // ses lignes dans un autre ordre — ce que rien ne garantit côté SQL.
      recoCache.invalidateUser(7);
      setupTiedPool(true);
      const second = await service.buildUserRecommendations(7, 50, 0);

      expect(second.map((d) => d.muId)).toEqual(first.map((d) => d.muId));
    });

    /**
     * Les écritures en tâche de fond (`hydrateIncompleteDtosInBackground` →
     * `getMangaDetails`) remplissent `type` — précisément la clé de
     * regroupement de l'entrelacement. Avant le correctif, la requête de
     * l'accueil déclenchait ces écritures et la requête de « Voir tout »,
     * quelques secondes plus tard, recalculait tout sur une base modifiée.
     */
    it("une écriture en tâche de fond entre les deux écrans ne réordonne plus la liste", async () => {
      // Bibliothèque 100 % manhwa → profil marqué, l'entrelacement s'applique.
      userMangaRepo.find.mockResolvedValue(
        ['1000', '1001'].map((muId, index) =>
          makeUserManga({
            id: index + 1,
            manga: makeManga({ id: index + 1, mu_id: muId, type: 'Manhwa' }),
          }),
        ),
      );
      const candidateIds = Array.from({ length: 14 }, (_, i) =>
        String(2001 + i),
      );
      mangasService.getCachedRecommendations.mockImplementation(
        async (muId: number) =>
          candidateIds.map((id) => makeReco(String(muId), id, 10)),
      );

      // `hydrated` simule le remplissage de `type` par la tâche de fond.
      let hydrated = false;
      mangaRepo.find.mockImplementation(({ where }: any) => {
        const ids: string[] = where.mu_id._value;
        return Promise.resolve(
          ids.map((id) =>
            makeManga({
              mu_id: id,
              title: `Titre ${id}`,
              type: hydrated && Number(id) >= 2008 ? 'Manhwa' : undefined,
            }),
          ),
        );
      });

      const home = await service.buildUserRecommendations(11, 10, 0);
      hydrated = true;
      const seeAll = await service.buildUserRecommendations(11, 50, 0);

      expect(home).toHaveLength(10);
      expect(seeAll.slice(0, 10).map((d) => d.muId)).toEqual(
        home.map((d) => d.muId),
      );
    });

    describe('bornes de la fenêtre', () => {
      beforeEach(() => setupTiedPool());

      it('un limit négatif ne produit pas un slice(0, -1)', async () => {
        const result = await service.buildUserRecommendations(7, -1, 0);
        expect(result).toHaveLength(1);
        expect(result[0].muId).toBe(2001);
      });

      it('un limit nul est ramené au plancher de 1', async () => {
        expect(await service.buildUserRecommendations(7, 0, 0)).toHaveLength(1);
      });

      it('un offset négatif est ramené à 0', async () => {
        const result = await service.buildUserRecommendations(7, 3, -5);
        expect(result.map((d) => d.muId)).toEqual([2001, 2002, 2003]);
      });

      it('un limit au-delà du plafond ne dépasse pas la liste canonique', async () => {
        const result = await service.buildUserRecommendations(7, 10_000, 0);
        expect(result).toHaveLength(14);
      });
    });

    describe('bibliothèque vide (démarrage à froid)', () => {
      /** Top communauté à notes ex æquo, sleepers absents. */
      function setupColdStart(reversed = false): void {
        userMangaRepo.find.mockResolvedValue([]);
        const rows = ['5003', '5001', '5002', '5000'].map((manga_id) => ({
          manga_id,
          avg: '8.0',
          count: '10',
        }));
        userMangaRepo.createQueryBuilder = jest.fn(() => ({
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          having: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          addOrderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          getRawMany: jest
            .fn()
            .mockResolvedValue(reversed ? [...rows].reverse() : rows),
        })) as any;
        mangaRepo.find.mockImplementation(({ where }: any) => {
          const ids: string[] = where.mu_id._value;
          return Promise.resolve(
            ids.map((id) => makeManga({ mu_id: id, title: `Manga ${id}` })),
          );
        });
        // Sleepers : aucun candidat (le top communauté suffit ici).
        mangaRepo.createQueryBuilder = jest.fn(() => ({
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        })) as any;
        mangasService.getCommunityRatings.mockImplementation(
          async (muIds: string[]) =>
            new Map(
              muIds.map((muId) => [
                muId,
                {
                  communityRating: 8,
                  communityRatingCount: 10,
                  aggregatedRating: 7.5,
                },
              ]),
            ),
        );
      }

      it('limit=10 reste le préfixe de limit=50 sur une bibliothèque vide', async () => {
        setupColdStart();
        const home = await service.buildUserRecommendations(9, 10, 0);
        const seeAll = await service.buildUserRecommendations(9, 50, 0);
        expect(home.length).toBeGreaterThan(0);
        expect(seeAll.slice(0, home.length).map((d) => d.muId)).toEqual(
          home.map((d) => d.muId),
        );
      });

      it("garde le même ordre à deux calculs, quel que soit l'ordre des lignes", async () => {
        setupColdStart();
        const first = await service.buildUserRecommendations(9, 50, 0);
        recoCache.invalidateUser(9);
        setupColdStart(true);
        const second = await service.buildUserRecommendations(9, 50, 0);
        expect(first.length).toBeGreaterThan(0);
        expect(second.map((d) => d.muId)).toEqual(first.map((d) => d.muId));
      });
    });
  });
});
