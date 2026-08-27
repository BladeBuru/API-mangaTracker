import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { of, throwError } from 'rxjs';
import { CatalogSyncService } from './catalog-sync.service';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { Manga } from './manga.entity';
import { MangasService } from './mangas.service';

/** Réponse MU search : `count` records à partir de `firstId`. */
function muPage(
  firstId: number,
  count: number,
  totalHits: number,
  opts?: { withGenres?: boolean },
) {
  const withGenres = opts?.withGenres ?? true;
  return {
    data: {
      total_hits: totalHits,
      results: Array.from({ length: count }, (_, i) => ({
        record: {
          series_id: firstId + i,
          title: `Manga ${firstId + i}`,
          year: '2020',
          bayesian_rating: 8.1,
          image: {
            url: {
              original: `https://cdn/${firstId + i}.jpg`,
              thumb: `https://cdn/${firstId + i}-t.jpg`,
            },
          },
          genres: withGenres ? [{ genre: 'Action' }] : undefined,
        },
      })),
    },
  };
}

function axiosError(status: number) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: { status },
  };
}

interface InsertCall {
  values: Array<Record<string, unknown>>;
  orUpdateCols: string[];
}

describe('CatalogSyncService', () => {
  let service: CatalogSyncService;
  let postMock: jest.Mock;
  let stateRepo: {
    findOneBy: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let mangaRepo: { createQueryBuilder: jest.Mock };
  let mangasService: { getMangaDetails: jest.Mock };
  let insertCalls: InsertCall[];
  let selectQb: {
    where: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    getMany: jest.Mock;
  };
  let sleepMock: jest.Mock;

  /** État persistant simulé (dernier `save` par job_name). */
  let savedStates: Array<Record<string, unknown>>;

  function makeState(
    overrides: Partial<CatalogSyncState> = {},
  ): CatalogSyncState {
    const state = new CatalogSyncState();
    state.id = 1;
    state.job_name = 'catalog:rating';
    state.last_completed_page = 0;
    state.total_pages = null;
    state.last_run_at = null;
    state.last_run_status = null;
    state.consecutive_failures = 0;
    return Object.assign(state, overrides);
  }

  function makeInsertQb() {
    const captured: Partial<InsertCall> = {};
    const qb = {
      insert: jest.fn(() => qb),
      into: jest.fn(() => qb),
      values: jest.fn((v: Array<Record<string, unknown>>) => {
        captured.values = v;
        return qb;
      }),
      orUpdate: jest.fn((cols: string[]) => {
        captured.orUpdateCols = cols;
        return qb;
      }),
      execute: jest.fn(() => {
        insertCalls.push({
          values: captured.values ?? [],
          orUpdateCols: captured.orUpdateCols ?? [],
        });
        return Promise.resolve({});
      }),
    };
    return qb;
  }

  beforeEach(async () => {
    insertCalls = [];
    savedStates = [];
    postMock = jest.fn();
    sleepMock = jest.fn().mockResolvedValue(undefined);

    stateRepo = {
      findOneBy: jest.fn().mockResolvedValue(null),
      create: jest.fn((partial: Partial<CatalogSyncState>) =>
        makeState(partial),
      ),
      save: jest.fn((s: CatalogSyncState) => {
        savedStates.push({ ...s });
        return Promise.resolve(s);
      }),
    };

    selectQb = {
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };

    mangaRepo = {
      // Sans alias → chaîne insert/upsert ; avec alias ('m') → select.
      createQueryBuilder: jest.fn((alias?: string) =>
        alias ? selectQb : makeInsertQb(),
      ),
    };

    mangasService = { getMangaDetails: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogSyncService,
        { provide: HttpService, useValue: { post: postMock } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'NODE_ENV' ? 'test' : undefined,
            ),
          },
        },
        { provide: getRepositoryToken(CatalogSyncState), useValue: stateRepo },
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
        { provide: MangasService, useValue: mangasService },
      ],
    }).compile();

    service = module.get<CatalogSyncService>(CatalogSyncService);
    service.sleep = sleepMock;
  });

  describe('pagination / reprise', () => {
    it('reprend au curseur persisté et complète la passe (curseur remis à 0, statut completed)', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        makeState({ last_completed_page: 2, total_pages: 4 }),
      );
      // 400 hits / perpage 100 → 4 pages au total.
      postMock.mockImplementation((_url: string, payload: { page: number }) =>
        of(muPage(payload.page * 1000, 100, 400)),
      );

      await service.runOnce('catalog:rating');

      // Reprise : pages 3 et 4 uniquement.
      expect(postMock).toHaveBeenCalledTimes(2);
      const pages = postMock.mock.calls.map((c) => c[1].page);
      expect(pages).toEqual([3, 4]);
      // Payload conforme : orderby=rating, perpage=100, NSFW exclus.
      const payload = postMock.mock.calls[0][1];
      expect(payload.orderby).toBe('rating');
      expect(payload.perpage).toBe(100);
      expect(payload.exclude_genre).toContain('Hentai');

      // État final : passe complétée, curseur remis à 0.
      const final = savedStates[savedStates.length - 1];
      expect(final.last_completed_page).toBe(0);
      expect(final.last_run_status).toBe('completed');
      expect(final.consecutive_failures).toBe(0);
    });

    it("s'arrête au budget PAGES_PER_RUN en conservant le curseur (statut partial)", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CatalogSyncService,
          { provide: HttpService, useValue: { post: postMock } },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => {
                if (key === 'CATALOG_SYNC_PAGES_PER_RUN') return '2';
                return key === 'NODE_ENV' ? 'test' : undefined;
              }),
            },
          },
          {
            provide: getRepositoryToken(CatalogSyncState),
            useValue: stateRepo,
          },
          { provide: getRepositoryToken(Manga), useValue: mangaRepo },
          { provide: MangasService, useValue: mangasService },
        ],
      }).compile();
      const budgeted = module.get<CatalogSyncService>(CatalogSyncService);
      budgeted.sleep = sleepMock;

      stateRepo.findOneBy.mockResolvedValue(makeState());
      postMock.mockImplementation((_url: string, payload: { page: number }) =>
        of(muPage(payload.page * 1000, 100, 1000)),
      );

      await budgeted.runOnce('catalog:rating');

      // Budget 2 pages sur 10 → arrêt propre, curseur conservé.
      expect(postMock).toHaveBeenCalledTimes(2);
      const final = savedStates[savedStates.length - 1];
      expect(final.last_completed_page).toBe(2);
      expect(final.last_run_status).toBe('partial');
    });
  });

  describe('backoff / arrêt partiel', () => {
    it('429 persistant : 4 retries (5/10/20/40 s) puis partial, curseur conservé, failures++', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        makeState({
          last_completed_page: 1,
          total_pages: 3,
          consecutive_failures: 1,
        }),
      );
      postMock.mockImplementation(() => throwError(() => axiosError(429)));

      await service.runOnce('catalog:rating');

      // 1 tentative initiale + 4 retries.
      expect(postMock).toHaveBeenCalledTimes(5);
      expect(sleepMock).toHaveBeenCalledWith(5_000);
      expect(sleepMock).toHaveBeenCalledWith(10_000);
      expect(sleepMock).toHaveBeenCalledWith(20_000);
      expect(sleepMock).toHaveBeenCalledWith(40_000);

      const final = savedStates[savedStates.length - 1];
      expect(final.last_completed_page).toBe(1); // curseur conservé
      expect(final.last_run_status).toBe('partial');
      expect(final.consecutive_failures).toBe(2);
      // Rien n'a été upserté.
      expect(insertCalls).toHaveLength(0);
    });

    it('reprend le backoff sur 5xx puis réussit (pas de partial)', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        makeState({ last_completed_page: 0, total_pages: 1 }),
      );
      postMock
        .mockImplementationOnce(() => throwError(() => axiosError(503)))
        .mockImplementation(() => of(muPage(1000, 100, 100)));

      await service.runOnce('catalog:rating');

      expect(postMock).toHaveBeenCalledTimes(2);
      expect(sleepMock).toHaveBeenCalledWith(5_000);
      const final = savedStates[savedStates.length - 1];
      expect(final.last_run_status).toBe('completed');
    });

    it('erreur non-retryable (400) : arrêt partiel immédiat sans retry', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        makeState({ last_completed_page: 0, total_pages: 2 }),
      );
      postMock.mockImplementation(() => throwError(() => axiosError(400)));

      await service.runOnce('catalog:rating');

      expect(postMock).toHaveBeenCalledTimes(1);
      const final = savedStates[savedStates.length - 1];
      expect(final.last_run_status).toBe('partial');
      expect(final.consecutive_failures).toBe(1);
    });
  });

  describe('upsert en 2 lots (genres)', () => {
    it('sépare les records avec/sans genres — le 2e lot omet la colonne genres', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        makeState({ last_completed_page: 0, total_pages: 1 }),
      );
      const page = {
        data: {
          total_hits: 2,
          results: [
            muPage(1000, 1, 2).data.results[0], // avec genres
            muPage(2000, 1, 2, { withGenres: false }).data.results[0], // sans
          ],
        },
      };
      postMock.mockReturnValue(of(page));

      await service.runOnce('catalog:rating');

      expect(insertCalls).toHaveLength(2);
      const [avecGenres, sansGenres] = insertCalls;
      expect(avecGenres.orUpdateCols).toContain('genres');
      expect(avecGenres.values[0].mu_id).toBe('1000');
      expect(avecGenres.values[0].genres).toEqual(['Action']);
      // Le lot sans genres n'update PAS la colonne genres (jamais écrasée
      // par null) ni total_chapters/completed/associated.
      expect(sansGenres.orUpdateCols).not.toContain('genres');
      expect(sansGenres.values[0].mu_id).toBe('2000');
      for (const call of insertCalls) {
        expect(call.orUpdateCols).not.toContain('total_chapters');
        expect(call.orUpdateCols).not.toContain('completed');
        expect(call.orUpdateCols).not.toContain('associated');
      }
    });

    it('payload entièrement sans genres → un seul lot, sans la colonne genres', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        makeState({ last_completed_page: 0, total_pages: 1 }),
      );
      postMock.mockReturnValue(of(muPage(1000, 3, 3, { withGenres: false })));

      await service.runOnce('catalog:rating');

      expect(insertCalls).toHaveLength(1);
      expect(insertCalls[0].orUpdateCols).not.toContain('genres');
      expect(insertCalls[0].values).toHaveLength(3);
    });

    it("n'écrase JAMAIS rating/year/covers par null (record search sans bayesian_rating)", async () => {
      stateRepo.findOneBy.mockResolvedValue(
        makeState({ last_completed_page: 0, total_pages: 1 }),
      );
      // Record MU minimal : pas de year, pas de bayesian_rating, pas d'image.
      const page = {
        data: {
          total_hits: 1,
          results: [
            {
              record: {
                series_id: 5000,
                title: 'Sleeper Hit',
                genres: [{ genre: 'Action' }],
              },
            },
          ],
        },
      };
      postMock.mockReturnValue(of(page));

      await service.runOnce('catalog:rating');

      expect(insertCalls).toHaveLength(1);
      const cols = insertCalls[0].orUpdateCols;
      // title + genres (non-null) restent écrasables ; rating/year/covers sont
      // OMIS → une note/année/cover déjà hydratée en base n'est pas remise à
      // null par ce record search incomplet.
      expect(cols).toContain('title');
      expect(cols).toContain('genres');
      expect(cols).not.toContain('rating');
      expect(cols).not.toContain('year');
      expect(cols).not.toContain('small_cover_url');
      expect(cols).not.toContain('medium_cover_url');
      // L'INSERT initial garde bien null (colonnes nullable).
      expect(insertCalls[0].values[0].rating).toBeNull();
      expect(insertCalls[0].values[0].year).toBeNull();
    });
  });

  describe('erreur DB (arrêt propre)', () => {
    it("une erreur d'upsert → statut partial, failures++, curseur conservé, PAS de propagation", async () => {
      stateRepo.findOneBy.mockResolvedValue(
        makeState({
          last_completed_page: 0,
          total_pages: 2,
          consecutive_failures: 0,
        }),
      );
      postMock.mockImplementation((_url: string, payload: { page: number }) =>
        of(muPage(payload.page * 1000, 100, 200)),
      );
      // L'upsert (QB sans alias) rejette ; le select (QB avec alias) reste ok.
      mangaRepo.createQueryBuilder.mockImplementation((alias?: string) => {
        if (alias) return selectQb;
        const qb = makeInsertQb();
        qb.execute = jest.fn().mockRejectedValue(new Error('DB down'));
        return qb;
      });

      // Ne doit pas rejeter (sinon les passes suivantes du run sauteraient).
      await expect(service.runOnce('catalog:rating')).resolves.toBeUndefined();

      const final = savedStates[savedStates.length - 1];
      expect(final.last_run_status).toBe('partial');
      expect(final.consecutive_failures).toBe(1);
      expect(final.last_completed_page).toBe(0); // curseur conservé
    });
  });

  describe('hydrateMissingGenres', () => {
    function stub(muId: string): Manga {
      const manga = new Manga();
      manga.mu_id = muId;
      manga.title = `Stub ${muId}`;
      return manga;
    }

    it('applique le budget en LIMIT SQL et hydrate via getMangaDetails', async () => {
      selectQb.getMany.mockResolvedValue([stub('100'), stub('200')]);

      const hydrated = await service.hydrateMissingGenres(2);

      expect(selectQb.limit).toHaveBeenCalledWith(2);
      expect(mangasService.getMangaDetails).toHaveBeenCalledTimes(2);
      expect(mangasService.getMangaDetails).toHaveBeenCalledWith(100);
      expect(mangasService.getMangaDetails).toHaveBeenCalledWith(200);
      expect(hydrated).toBe(2);
      // Rythme : 1 appel / delayMs (défaut 2000 ms).
      expect(sleepMock).toHaveBeenCalledWith(2000);
    });

    it('budget par défaut = CATALOG_SYNC_HYDRATION_BUDGET (200)', async () => {
      selectQb.getMany.mockResolvedValue([]);
      await service.hydrateMissingGenres();
      expect(selectQb.limit).toHaveBeenCalledWith(200);
    });

    it("un échec getMangaDetails n'interrompt pas la boucle", async () => {
      selectQb.getMany.mockResolvedValue([stub('100'), stub('200')]);
      mangasService.getMangaDetails
        .mockRejectedValueOnce(new Error('MU down'))
        .mockResolvedValueOnce({});

      const hydrated = await service.hydrateMissingGenres(2);

      expect(mangasService.getMangaDetails).toHaveBeenCalledTimes(2);
      expect(hydrated).toBe(1);
    });
  });

  describe('anti-réentrance', () => {
    it('un runOnce concurrent est ignoré tant que le premier est en cours', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        makeState({ last_completed_page: 0, total_pages: 1 }),
      );
      postMock.mockReturnValue(of(muPage(1000, 100, 100)));

      await Promise.all([
        service.runOnce('catalog:rating'),
        service.runOnce('catalog:rating'),
      ]);

      // Une seule passe a fetché (le 2e run est un no-op).
      expect(postMock).toHaveBeenCalledTimes(1);
    });

    it('le flag est relâché après le run (un run suivant repart)', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        makeState({ last_completed_page: 0, total_pages: 1 }),
      );
      postMock.mockReturnValue(of(muPage(1000, 100, 100)));

      await service.runOnce('catalog:rating');
      stateRepo.findOneBy.mockResolvedValue(
        makeState({ last_completed_page: 0, total_pages: 1 }),
      );
      await service.runOnce('catalog:rating');

      expect(postMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('rythme réseau', () => {
    it('attend delayMs (2000 ms) après chaque page ingérée', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        makeState({ last_completed_page: 0, total_pages: 2 }),
      );
      postMock.mockImplementation((_url: string, payload: { page: number }) =>
        of(muPage(payload.page * 1000, 100, 200)),
      );

      await service.runOnce('catalog:rating');

      const delayCalls = sleepMock.mock.calls.filter((c) => c[0] === 2000);
      expect(delayCalls).toHaveLength(2); // une pause par page
    });
  });

  describe('handleNightlySync', () => {
    it('est un no-op quand CATALOG_SYNC_ENABLED est résolu à false (NODE_ENV=test)', async () => {
      await service.handleNightlySync();
      expect(postMock).not.toHaveBeenCalled();
      expect(sleepMock).not.toHaveBeenCalled();
    });
  });
});
