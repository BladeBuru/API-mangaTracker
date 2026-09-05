import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CatalogPageIngestService } from './catalog-page-ingest.service';
import { CatalogShardPlannerService } from './catalog-shard-planner.service';
import { CatalogShardRunnerService } from './catalog-shard-runner.service';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { CatalogTypeBackfillService } from './catalog-type-backfill.service';
import { Manga } from './manga.entity';
import { MangasService } from './mangas.service';
import { MuJobLockService } from './mu-job-lock.service';

/** Samedi 2026-09-05 01:00 — année courante 2026. */
const NOW = new Date('2026-09-05T01:00:00');

interface IngestCall {
  jobName: string;
  page: number;
  type?: string;
  year?: number;
}

/**
 * Tests du rattrapage de `manga.type`. Le runner de shard, le verrou MU et
 * le planificateur sont les VRAIS services (purs / in-memory) : ce qui est
 * vérifié est la reprise réelle des curseurs et l'exclusion mutuelle réelle,
 * pas une simulation.
 */
describe('CatalogTypeBackfillService', () => {
  let service: CatalogTypeBackfillService;
  let lock: MuJobLockService;
  let stateRepo: {
    find: jest.Mock;
    findOneBy: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let mangaRepo: { createQueryBuilder: jest.Mock };
  let ingestService: { ingestPage: jest.Mock };
  let mangasService: { getMangaDetails: jest.Mock };
  let sleepMock: jest.Mock;
  let store: Map<string, CatalogSyncState>;
  let ingestCalls: IngestCall[];
  /** `mu_id` renvoyés par la requête « bibliothèque sans type ». */
  let libraryRows: Array<{ mu_id: string }>;

  function makeState(
    overrides: Partial<CatalogSyncState> = {},
  ): CatalogSyncState {
    const state = new CatalogSyncState();
    state.id = 1;
    state.job_name = 'type:Manhwa:year:2026';
    state.last_completed_page = 0;
    state.total_pages = null;
    state.last_run_at = null;
    state.last_run_status = null;
    state.consecutive_failures = 0;
    state.completed_at = null;
    state.saturated = false;
    state.total_hits = null;
    return Object.assign(state, overrides);
  }

  /** `totalHits` constant → chaque shard fait `ceil(totalHits / 100)` pages. */
  function ingestReturns(totalHits: number): void {
    ingestService.ingestPage.mockImplementation(
      (shard: IngestCall, page: number) => {
        ingestCalls.push({
          jobName: shard.jobName,
          page,
          type: shard.type,
          year: shard.year,
        });
        return Promise.resolve(totalHits);
      },
    );
  }

  async function build(
    overrides: Record<string, string> = {},
  ): Promise<CatalogTypeBackfillService> {
    const config = {
      get: jest.fn((key: string) =>
        key === 'NODE_ENV' ? 'test' : overrides[key],
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogTypeBackfillService,
        CatalogShardRunnerService,
        CatalogShardPlannerService,
        MuJobLockService,
        { provide: ConfigService, useValue: config },
        { provide: getRepositoryToken(CatalogSyncState), useValue: stateRepo },
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
        { provide: CatalogPageIngestService, useValue: ingestService },
        { provide: MangasService, useValue: mangasService },
      ],
    }).compile();

    const built = module.get<CatalogTypeBackfillService>(
      CatalogTypeBackfillService,
    );
    built.sleep = sleepMock;
    module.get<CatalogShardRunnerService>(CatalogShardRunnerService).sleep =
      sleepMock;
    lock = module.get<MuJobLockService>(MuJobLockService);
    return built;
  }

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    store = new Map();
    ingestCalls = [];
    libraryRows = [];
    sleepMock = jest.fn().mockResolvedValue(undefined);

    stateRepo = {
      find: jest.fn(() => Promise.resolve([...store.values()])),
      findOneBy: jest.fn(({ job_name }: { job_name: string }) =>
        Promise.resolve(store.get(job_name) ?? null),
      ),
      create: jest.fn((partial: Partial<CatalogSyncState>) =>
        makeState(partial),
      ),
      save: jest.fn((s: CatalogSyncState) => {
        store.set(s.job_name, s);
        return Promise.resolve(s);
      }),
    };
    mangaRepo = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawMany: jest.fn(() => Promise.resolve(libraryRows)),
      })),
    };
    ingestService = { ingestPage: jest.fn() };
    mangasService = { getMangaDetails: jest.fn().mockResolvedValue({}) };

    // Plancher 2025 → 2 années × 2 types = 4 shards par défaut.
    service = await build({ CATALOG_TYPE_BACKFILL_YEAR_FLOOR: '2025' });
    ingestReturns(150); // 2 pages par shard
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('volet A — bibliothèques', () => {
    it('relit via getMangaDetails chaque titre en bibliothèque sans type, à 1 req / 2 s', async () => {
      libraryRows = [{ mu_id: '111' }, { mu_id: '222' }, { mu_id: '333' }];

      const outcome = await service.runOnce();

      expect(mangasService.getMangaDetails.mock.calls.map((c) => c[0])).toEqual(
        [111, 222, 333],
      );
      expect(outcome?.libraryAttempted).toBe(3);
      expect(outcome?.libraryHydrated).toBe(3);
      // La requête cible `type IS NULL` + présence dans `user_manga`.
      const qb = mangaRepo.createQueryBuilder.mock.results[0].value;
      expect(qb.where).toHaveBeenCalledWith('m.type IS NULL');
      expect(String(qb.andWhere.mock.calls[0][0])).toContain('user_manga');
      // 2 pauses entre 3 fiches (pas de pause après la dernière).
      const libraryPauses = sleepMock.mock.calls.slice(0, 2);
      expect(libraryPauses).toEqual([[2000], [2000]]);
    });

    it("un échec MU sur une fiche n'interrompt pas le volet (comptabilisé, pas propagé)", async () => {
      libraryRows = [{ mu_id: '111' }, { mu_id: '222' }];
      mangasService.getMangaDetails
        .mockRejectedValueOnce(new Error('503'))
        .mockResolvedValueOnce({});

      const outcome = await service.runOnce();

      expect(outcome?.libraryAttempted).toBe(2);
      expect(outcome?.libraryHydrated).toBe(1);
    });

    it('rien à relire → aucun appel MU', async () => {
      await service.runOnce();
      expect(mangasService.getMangaDetails).not.toHaveBeenCalled();
    });

    it('au boot, le volet A tourne seul sous verrou puis le libère', async () => {
      libraryRows = [{ mu_id: '111' }];

      await service.runLibraryBackfillAtBoot();

      expect(mangasService.getMangaDetails).toHaveBeenCalledWith(111);
      expect(ingestService.ingestPage).not.toHaveBeenCalled();
      expect(lock.current).toBeNull();
    });
  });

  describe('volet B — shards type × année', () => {
    it('parcourt Manhwa puis Manhua par année décroissante, avec le filtre type', async () => {
      const outcome = await service.runOnce();

      expect(ingestCalls.map((c) => c.jobName)).toEqual([
        'type:Manhwa:year:2026',
        'type:Manhwa:year:2026',
        'type:Manhua:year:2026',
        'type:Manhua:year:2026',
        'type:Manhwa:year:2025',
        'type:Manhwa:year:2025',
        'type:Manhua:year:2025',
        'type:Manhua:year:2025',
      ]);
      expect(ingestCalls[0]).toMatchObject({
        type: 'Manhwa',
        year: 2026,
        page: 1,
      });
      expect(ingestCalls[2]).toMatchObject({
        type: 'Manhua',
        year: 2026,
        page: 1,
      });
      expect(outcome).toMatchObject({
        pagesFetched: 8,
        shardsTouched: 4,
        circuitBroken: false,
      });
      // Chaque shard terminé est horodaté → sorti de la file au run suivant.
      for (const jobName of store.keys()) {
        expect(store.get(jobName)?.completed_at).toBeInstanceOf(Date);
        expect(store.get(jobName)?.last_completed_page).toBe(0);
      }
    });

    it('respecte le budget de pages par nuit et reprend au curseur la nuit suivante', async () => {
      service = await build({
        CATALOG_TYPE_BACKFILL_YEAR_FLOOR: '2025',
        CATALOG_TYPE_BACKFILL_PAGES_PER_RUN: '3',
      });
      ingestReturns(150);

      const first = await service.runOnce();
      expect(first?.pagesFetched).toBe(3);
      // Shard 1 complet (2 pages), shard 2 arrêté page 1.
      expect(store.get('type:Manhwa:year:2026')?.completed_at).toBeInstanceOf(
        Date,
      );
      expect(store.get('type:Manhua:year:2026')).toMatchObject({
        last_completed_page: 1,
        last_run_status: 'partial',
        completed_at: null,
      });

      ingestCalls = [];
      const second = await service.runOnce();
      expect(second?.pagesFetched).toBe(3);
      // Nuit 2 : reprise EXACTE à la page 2 du shard interrompu, jamais de
      // retour sur le shard terminé.
      expect(ingestCalls[0]).toMatchObject({
        jobName: 'type:Manhua:year:2026',
        page: 2,
      });
      expect(
        ingestCalls.some((c) => c.jobName === 'type:Manhwa:year:2026'),
      ).toBe(false);
    });

    it('un shard terminé ne repasse JAMAIS (rattrapage ponctuel)', async () => {
      await service.runOnce();
      ingestCalls = [];

      const outcome = await service.runOnce();

      expect(ingestCalls).toEqual([]);
      expect(outcome).toMatchObject({ pagesFetched: 0, shardsTouched: 0 });
    });

    it('disjoncteur : 3 shards consécutifs en échec interrompent le run, curseurs conservés', async () => {
      ingestService.ingestPage.mockImplementation((shard: IngestCall) => {
        ingestCalls.push({ jobName: shard.jobName, page: 1 });
        return Promise.reject(new Error('MU down'));
      });

      const outcome = await service.runOnce();

      // 4 shards en file, seuls 3 sont tentés.
      expect(ingestCalls).toHaveLength(3);
      expect(outcome?.circuitBroken).toBe(true);
      expect(store.get('type:Manhwa:year:2026')).toMatchObject({
        last_run_status: 'partial',
        consecutive_failures: 1,
        last_completed_page: 0,
      });
    });

    it('lit les types ciblés depuis CATALOG_TYPE_BACKFILL_TYPES', async () => {
      service = await build({
        CATALOG_TYPE_BACKFILL_YEAR_FLOOR: '2026',
        CATALOG_TYPE_BACKFILL_TYPES: 'OEL',
      });
      ingestReturns(50);

      await service.runOnce();

      expect(ingestCalls.map((c) => c.jobName)).toEqual(['type:OEL:year:2026']);
    });
  });

  describe('verrou MU partagé', () => {
    it('se retire (null) si un autre job MU tient le verrou', async () => {
      expect(lock.tryAcquire('catalog')).toBe(true);

      const outcome = await service.runOnce();

      expect(outcome).toBeNull();
      expect(ingestService.ingestPage).not.toHaveBeenCalled();
      expect(mangasService.getMangaDetails).not.toHaveBeenCalled();
      // Le verrou du job en cours n'a pas été touché.
      expect(lock.current).toBe('catalog');
    });

    it('libère le verrou en fin de run, même après un disjoncteur', async () => {
      ingestService.ingestPage.mockRejectedValue(new Error('MU down'));

      await service.runOnce();

      expect(lock.current).toBeNull();
      expect(lock.tryAcquire('releases')).toBe(true);
    });

    it('un runOnce concurrent est ignoré tant que le premier est en cours', async () => {
      const [first, second] = await Promise.all([
        service.runOnce(),
        service.runOnce(),
      ]);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(ingestCalls).toHaveLength(8); // un seul parcours
    });
  });
});
