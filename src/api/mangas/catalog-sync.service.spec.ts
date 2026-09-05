import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CatalogHydrationService } from './catalog-hydration.service';
import { CatalogPageIngestService } from './catalog-page-ingest.service';
import { CatalogShardPlannerService } from './catalog-shard-planner.service';
import { CatalogShardRunnerService } from './catalog-shard-runner.service';
import { CatalogSyncService } from './catalog-sync.service';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { Manga } from './manga.entity';
import { MuJobLockService } from './mu-job-lock.service';

/** Mercredi 2026-08-26 : jour sans passe hebdo `week_pos`. */
const WEDNESDAY = new Date('2026-08-26T03:30:00');

/** Une page ingérée : quel shard, quelle page. */
interface IngestCall {
  jobName: string;
  page: number;
}

/**
 * Tests d'orchestration du catalogue. Le planificateur est le VRAI service
 * (il est pur) : ce qui est vérifié ici est donc la reprise inter-shards
 * réelle, pas une simulation.
 */
describe('CatalogSyncService', () => {
  let service: CatalogSyncService;
  let stateRepo: {
    find: jest.Mock;
    findOneBy: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let ingestService: { ingestPage: jest.Mock };
  let hydrationService: { hydrateIncompleteRows: jest.Mock };
  let sleepMock: jest.Mock;

  /** Store persistant simulé — survit entre deux `runOnce` (deux « nuits »). */
  let store: Map<string, CatalogSyncState>;
  let savedStates: Array<Record<string, unknown>>;
  let ingestCalls: IngestCall[];

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
    state.completed_at = null;
    state.saturated = false;
    state.total_hits = null;
    return Object.assign(state, overrides);
  }

  /** Pré-remplit le store (état laissé par une nuit précédente). */
  function seed(state: CatalogSyncState): void {
    store.set(state.job_name, state);
  }

  /** Dernier état persisté pour un job donné. */
  function finalStateOf(jobName: string): Record<string, unknown> {
    const matches = savedStates.filter((s) => s.job_name === jobName);
    return matches[matches.length - 1];
  }

  /** `totalHits` constant → chaque shard fait `ceil(totalHits / 100)` pages. */
  function ingestReturns(totalHits: number): void {
    ingestService.ingestPage.mockImplementation(
      (shard: { jobName: string }, page: number) => {
        ingestCalls.push({ jobName: shard.jobName, page });
        return Promise.resolve(totalHits);
      },
    );
  }

  async function build(
    overrides: Record<string, string> = {},
  ): Promise<CatalogSyncService> {
    const config = {
      get: jest.fn((key: string) =>
        key === 'NODE_ENV' ? 'test' : overrides[key],
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogSyncService,
        CatalogShardPlannerService, // vrai planificateur (pur)
        CatalogShardRunnerService, // vraie passe de shard (curseur, pages)
        MuJobLockService, // vrai verrou MU partagé (in-memory)
        { provide: ConfigService, useValue: config },
        { provide: getRepositoryToken(CatalogSyncState), useValue: stateRepo },
        { provide: getRepositoryToken(Manga), useValue: {} },
        { provide: CatalogPageIngestService, useValue: ingestService },
        { provide: CatalogHydrationService, useValue: hydrationService },
      ],
    }).compile();

    const built = module.get<CatalogSyncService>(CatalogSyncService);
    built.sleep = sleepMock;
    // La cadence 1 req / 2 s vit dans le runner depuis son extraction.
    module.get<CatalogShardRunnerService>(CatalogShardRunnerService).sleep =
      sleepMock;
    return built;
  }

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(WEDNESDAY);
    store = new Map();
    savedStates = [];
    ingestCalls = [];
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
        savedStates.push({ ...s });
        return Promise.resolve(s);
      }),
    };

    ingestService = { ingestPage: jest.fn() };
    hydrationService = {
      hydrateIncompleteRows: jest.fn().mockResolvedValue(0),
    };

    service = await build();
    ingestReturns(400);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('pagination / reprise dans un shard', () => {
    it('reprend au curseur persisté et complète la passe (curseur remis à 0, statut completed)', async () => {
      seed(makeState({ last_completed_page: 2, total_pages: 4 }));
      ingestReturns(400); // 400 hits / 100 → 4 pages

      await service.runOnce('catalog:rating');

      // Reprise : pages 3 et 4 uniquement.
      expect(ingestCalls.map((c) => c.page)).toEqual([3, 4]);

      const final = finalStateOf('catalog:rating');
      expect(final.last_completed_page).toBe(0);
      expect(final.last_run_status).toBe('completed');
      expect(final.consecutive_failures).toBe(0);
      // La complétion est horodatée : c'est elle qui met le shard au repos.
      expect(final.completed_at).toBeInstanceOf(Date);
    });

    it("s'arrête au budget PAGES_PER_RUN en conservant le curseur (statut partial)", async () => {
      service = await build({ CATALOG_SYNC_PAGES_PER_RUN: '2' });
      seed(makeState());
      ingestReturns(1000); // 10 pages disponibles

      await service.runOnce('catalog:rating');

      expect(ingestCalls).toHaveLength(2);
      const final = finalStateOf('catalog:rating');
      expect(final.last_completed_page).toBe(2);
      expect(final.last_run_status).toBe('partial');
      // Pas de completed_at → le shard reste en tête de file la nuit suivante.
      expect(final.completed_at).toBeNull();
    });
  });

  describe('CATALOG_SYNC_MAX_PAGES ne plafonne plus la pagination (bug corrigé)', () => {
    it('parcourt les 100 pages réelles malgré CATALOG_SYNC_MAX_PAGES=50', async () => {
      service = await build({
        CATALOG_SYNC_MAX_PAGES: '50',
        CATALOG_SYNC_PAGES_PER_RUN: '500',
      });
      seed(makeState());
      // 10 000 hits = le plafond MU → 100 pages réellement atteignables.
      ingestReturns(10_000);

      await service.runOnce('catalog:rating');

      // L'ancien code s'arrêtait à 50 et se déclarait `completed` : le curseur
      // ne pouvait jamais dépasser la page 50 et les mêmes ~5 000 titres
      // étaient réingérés chaque nuit.
      expect(ingestCalls).toHaveLength(100);
      expect(ingestCalls[99].page).toBe(100);
      expect(finalStateOf('catalog:rating').last_run_status).toBe('completed');
    });

    it('ne dépasse jamais le hard cap MU de 400 pages', async () => {
      service = await build({ CATALOG_SYNC_PAGES_PER_RUN: '1000' });
      seed(makeState());
      // total_hits gonflé artificiellement : 5000 pages « annoncées ».
      ingestReturns(500_000);

      await service.runOnce('catalog:rating');

      expect(ingestCalls).toHaveLength(400);
    });
  });

  describe('reprise inter-shards sur plusieurs nuits', () => {
    it('la nuit 2 repart sur le shard laissé en cours, sans re-parcourir les terminés', async () => {
      // File réduite : passe globale + années 2026 et 2025.
      const config = {
        CATALOG_SYNC_YEAR_FLOOR: '2025',
        CATALOG_SYNC_PAGES_PER_RUN: '3',
      };
      service = await build(config);
      ingestReturns(200); // 2 pages par shard

      // --- Nuit 1 : budget 3 pages ---
      await service.runOnce();

      expect(ingestCalls).toEqual([
        { jobName: 'catalog:rating', page: 1 },
        { jobName: 'catalog:rating', page: 2 },
        { jobName: 'catalog:year:2026', page: 1 },
      ]);
      expect(finalStateOf('catalog:rating').last_run_status).toBe('completed');
      expect(finalStateOf('catalog:year:2026').last_completed_page).toBe(1);

      // --- Nuit 2 : même service, store conservé ---
      ingestCalls = [];
      service = await build(config);
      ingestReturns(200);
      await service.runOnce();

      // Reprise EXACTE : 2026 à la page 2, puis enchaînement sur 2025.
      expect(ingestCalls).toEqual([
        { jobName: 'catalog:year:2026', page: 2 },
        { jobName: 'catalog:year:2025', page: 1 },
        { jobName: 'catalog:year:2025', page: 2 },
      ]);
      // La passe globale terminée la nuit 1 n'est PAS re-parcourue.
      expect(ingestCalls.some((c) => c.jobName === 'catalog:rating')).toBe(
        false,
      );
      expect(finalStateOf('catalog:year:2025').last_run_status).toBe(
        'completed',
      );
    });

    it('le budget de pages est global à la nuit, pas par shard', async () => {
      service = await build({
        CATALOG_SYNC_YEAR_FLOOR: '2020',
        CATALOG_SYNC_PAGES_PER_RUN: '5',
      });
      ingestReturns(200); // 2 pages par shard, 8 shards disponibles

      await service.runOnce();

      // 5 pages au total, réparties sur plusieurs shards — pas 5 par shard.
      expect(ingestCalls).toHaveLength(5);
      expect(new Set(ingestCalls.map((c) => c.jobName)).size).toBeGreaterThan(
        1,
      );
    });

    it('ne fait rien quand tous les shards sont terminés et frais', async () => {
      service = await build({ CATALOG_SYNC_YEAR_FLOOR: '2026' });
      seed(makeState({ job_name: 'catalog:rating', completed_at: WEDNESDAY }));
      seed(
        makeState({ job_name: 'catalog:year:2026', completed_at: WEDNESDAY }),
      );

      await service.runOnce();

      expect(ingestCalls).toHaveLength(0);
      // L'hydratation tourne quand même : elle a son propre budget.
      expect(hydrationService.hydrateIncompleteRows).toHaveBeenCalled();
    });
  });

  describe('saturation et sous-découpage', () => {
    it('marque le shard saturé dès la première page', async () => {
      service = await build({
        CATALOG_SYNC_YEAR_FLOOR: '2026',
        CATALOG_SYNC_PAGES_PER_RUN: '1',
      });
      // La passe globale est déjà terminée : on isole l'année.
      seed(makeState({ job_name: 'catalog:rating', completed_at: WEDNESDAY }));
      ingestReturns(10_000); // plafond MU atteint

      await service.runOnce();

      expect(ingestCalls[0].jobName).toBe('catalog:year:2026');
      expect(finalStateOf('catalog:year:2026').saturated).toBe(true);
    });

    it("enchaîne sur les sous-shards par genre une fois l'année parcourue", async () => {
      // Une année saturée annonce 100 pages : les sous-shards ne peuvent être
      // atteints dans le même run que si le budget couvre l'année entière.
      service = await build({
        CATALOG_SYNC_YEAR_FLOOR: '2026',
        CATALOG_SYNC_PAGES_PER_RUN: '105',
      });
      seed(makeState({ job_name: 'catalog:rating', completed_at: WEDNESDAY }));
      ingestReturns(10_000);

      await service.runOnce();

      // 100 pages sur l'année, puis bascule sur les sous-shards SANS attendre
      // la nuit suivante (splice dans la file du run en cours).
      expect(ingestCalls[99]).toEqual({
        jobName: 'catalog:year:2026',
        page: 100,
      });
      expect(finalStateOf('catalog:year:2026').last_run_status).toBe(
        'completed',
      );
      // Le 1er sous-shard prend la main et consomme le budget restant (lui
      // aussi sature : 100 pages annoncées).
      expect(ingestCalls.slice(100)).toEqual([
        { jobName: 'catalog:year:2026:genre:Action', page: 1 },
        { jobName: 'catalog:year:2026:genre:Action', page: 2 },
        { jobName: 'catalog:year:2026:genre:Action', page: 3 },
        { jobName: 'catalog:year:2026:genre:Action', page: 4 },
        { jobName: 'catalog:year:2026:genre:Action', page: 5 },
      ]);
    });

    it('la saturation persistée fait planifier les sous-shards dès la nuit suivante', async () => {
      const config = {
        CATALOG_SYNC_YEAR_FLOOR: '2026',
        CATALOG_SYNC_PAGES_PER_RUN: '1',
      };
      seed(makeState({ job_name: 'catalog:rating', completed_at: WEDNESDAY }));
      // Nuit 1 : l'année est marquée saturée mais loin d'être finie.
      service = await build(config);
      ingestReturns(10_000);
      await service.runOnce();

      // Nuit 2 : l'année reste en tête (inachevée), mais ses sous-shards sont
      // désormais dans la file — `saturated` est persisté.
      ingestCalls = [];
      service = await build(config);
      ingestReturns(10_000);
      await service.runOnce();

      expect(ingestCalls[0]).toEqual({
        jobName: 'catalog:year:2026',
        page: 2,
      });
      expect(store.get('catalog:year:2026')?.saturated).toBe(true);
    });

    it('ne marque pas saturé un shard sous le plafond', async () => {
      service = await build({ CATALOG_SYNC_YEAR_FLOOR: '2026' });
      seed(makeState({ job_name: 'catalog:rating', completed_at: WEDNESDAY }));
      ingestReturns(9_999);

      await service.runOnce();

      expect(finalStateOf('catalog:year:2026').saturated).toBe(false);
      expect(ingestCalls.some((c) => c.jobName.includes(':genre:'))).toBe(
        false,
      );
    });

    it('persiste le total_hits observé', async () => {
      seed(makeState());
      ingestReturns(4_781);

      await service.runOnce('catalog:rating');

      expect(finalStateOf('catalog:rating').total_hits).toBe(4_781);
    });
  });

  describe('arrêt propre sur erreur', () => {
    it("une erreur d'ingestion → statut partial, failures++, curseur conservé, PAS de propagation", async () => {
      seed(
        makeState({
          last_completed_page: 0,
          total_pages: 2,
          consecutive_failures: 0,
        }),
      );
      ingestService.ingestPage.mockRejectedValue(new Error('MU down'));

      // Ne doit pas rejeter (sinon les shards suivants du run sauteraient).
      await expect(service.runOnce('catalog:rating')).resolves.toBeUndefined();

      const final = finalStateOf('catalog:rating');
      expect(final.last_run_status).toBe('partial');
      expect(final.consecutive_failures).toBe(1);
      expect(final.last_completed_page).toBe(0); // curseur conservé
      expect(final.completed_at).toBeNull();
    });

    it('coupe-circuit : arrête le run après 3 shards consécutifs en échec', async () => {
      // Un shard en échec ne consomme AUCUN budget de page : sans garde, une
      // panne MU ferait enchaîner la centaine de shards de la file (≈ 500
      // requêtes et des heures de backoff cumulé dans la même nuit).
      service = await build({
        CATALOG_SYNC_YEAR_FLOOR: '1930',
        CATALOG_SYNC_PAGES_PER_RUN: '60',
      });
      ingestService.ingestPage.mockImplementation(
        (shard: { jobName: string }, page: number) => {
          ingestCalls.push({ jobName: shard.jobName, page });
          return Promise.reject(new Error('MU down'));
        },
      );

      await service.runOnce();

      // 3 shards tentés, pas les ~100 de la file.
      expect(ingestCalls).toHaveLength(3);
      expect(new Set(ingestCalls.map((c) => c.jobName)).size).toBe(3);
    });

    it('un shard en échec ne bloque pas les shards suivants de la nuit', async () => {
      service = await build({
        CATALOG_SYNC_YEAR_FLOOR: '2025',
        CATALOG_SYNC_PAGES_PER_RUN: '10',
      });
      ingestService.ingestPage.mockImplementation(
        (shard: { jobName: string }, page: number) => {
          ingestCalls.push({ jobName: shard.jobName, page });
          if (shard.jobName === 'catalog:rating') {
            return Promise.reject(new Error('MU down'));
          }
          return Promise.resolve(200);
        },
      );

      await service.runOnce();

      expect(finalStateOf('catalog:rating').last_run_status).toBe('partial');
      // Les années suivantes ont bien été traitées.
      expect(finalStateOf('catalog:year:2026').last_run_status).toBe(
        'completed',
      );
      expect(finalStateOf('catalog:year:2025').last_run_status).toBe(
        'completed',
      );
    });
  });

  describe('anti-réentrance', () => {
    it('un runOnce concurrent est ignoré tant que le premier est en cours', async () => {
      seed(makeState({ last_completed_page: 0, total_pages: 1 }));
      ingestReturns(100);

      await Promise.all([
        service.runOnce('catalog:rating'),
        service.runOnce('catalog:rating'),
      ]);

      expect(ingestCalls).toHaveLength(1);
    });

    it('le flag est relâché après le run (un run suivant repart)', async () => {
      seed(makeState({ last_completed_page: 0, total_pages: 1 }));
      ingestReturns(100);

      await service.runOnce('catalog:rating');
      seed(makeState({ last_completed_page: 0, total_pages: 1 }));
      await service.runOnce('catalog:rating');

      expect(ingestCalls).toHaveLength(2);
    });
  });

  describe('rythme réseau', () => {
    it('attend delayMs (2000 ms) après chaque page ingérée', async () => {
      seed(makeState({ last_completed_page: 0, total_pages: 2 }));
      ingestReturns(200);

      await service.runOnce('catalog:rating');

      const delayCalls = sleepMock.mock.calls.filter((c) => c[0] === 2000);
      expect(delayCalls).toHaveLength(2); // une pause par page
    });

    it('respecte le rythme à travers les shards, pas seulement dans un shard', async () => {
      // 4 shards : passe globale + années 2026, 2025, 2024.
      service = await build({
        CATALOG_SYNC_YEAR_FLOOR: '2024',
        CATALOG_SYNC_PAGES_PER_RUN: '4',
      });
      ingestReturns(100); // 1 page par shard

      await service.runOnce();

      expect(ingestCalls).toHaveLength(4);
      expect(new Set(ingestCalls.map((c) => c.jobName)).size).toBe(4);
      const delayCalls = sleepMock.mock.calls.filter((c) => c[0] === 2000);
      expect(delayCalls).toHaveLength(4);
    });
  });

  describe('runOnce ciblé', () => {
    it("jobName 'hydration' délègue au service d'hydratation sans toucher au catalogue", async () => {
      await service.runOnce('hydration');

      expect(hydrationService.hydrateIncompleteRows).toHaveBeenCalledTimes(1);
      expect(ingestCalls).toHaveLength(0);
    });

    it("jobName 'catalog:week_pos' est plafonné à 10 pages", async () => {
      service = await build({ CATALOG_SYNC_PAGES_PER_RUN: '100' });
      seed(makeState({ job_name: 'catalog:week_pos' }));
      ingestReturns(100_000);

      await service.runOnce('catalog:week_pos');

      expect(ingestCalls).toHaveLength(10);
      expect(ingestCalls[0].jobName).toBe('catalog:week_pos');
    });
  });

  describe('handleNightlySync', () => {
    it('est un no-op quand CATALOG_SYNC_ENABLED est résolu à false (NODE_ENV=test)', async () => {
      await service.handleNightlySync();

      expect(ingestCalls).toHaveLength(0);
      expect(sleepMock).not.toHaveBeenCalled();
    });
  });
});
