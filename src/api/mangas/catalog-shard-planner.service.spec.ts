import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { CatalogShardPlannerService } from './catalog-shard-planner.service';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { MU_SHARDABLE_GENRES, NSFW_GENRES } from './constants';

/** Un mercredi — évite le shard hebdo `week_pos` sauf test dédié. */
const WEDNESDAY = new Date('2026-08-26T03:30:00Z');
/** Un dimanche. */
const SUNDAY = new Date('2026-08-30T03:30:00Z');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Le planificateur est PUR : aucun repository, aucun réseau. Ces tests
 * décrivent la reprise inter-shards et les fenêtres de rafraîchissement, la
 * partie la plus subtile du découpage du catalogue par année.
 */
describe('CatalogShardPlannerService', () => {
  async function makePlanner(
    overrides: Record<string, string> = {},
  ): Promise<CatalogShardPlannerService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogShardPlannerService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'NODE_ENV' ? 'test' : overrides[key],
            ),
          },
        },
      ],
    }).compile();
    return module.get<CatalogShardPlannerService>(CatalogShardPlannerService);
  }

  function state(overrides: Partial<CatalogSyncState>): CatalogSyncState {
    const s = new CatalogSyncState();
    s.id = 1;
    s.job_name = 'catalog:rating';
    s.last_completed_page = 0;
    s.total_pages = null;
    s.last_run_at = null;
    s.last_run_status = null;
    s.consecutive_failures = 0;
    s.completed_at = null;
    s.saturated = false;
    s.total_hits = null;
    return Object.assign(s, overrides);
  }

  describe('composition de la file', () => {
    it('couvre toutes les années de la courante au plancher, en décroissant', async () => {
      const planner = await makePlanner();

      const queue = planner.planQueue([], WEDNESDAY);
      const years = queue
        .filter((s) => s.kind === 'year')
        .map((s) => s.year as number);

      expect(years[0]).toBe(2026); // année courante en tête
      expect(years[years.length - 1]).toBe(1930); // plancher mesuré
      expect(years).toHaveLength(2026 - 1930 + 1);
      // Strictement décroissant, sans trou.
      for (let i = 1; i < years.length; i++) {
        expect(years[i]).toBe(years[i - 1] - 1);
      }
    });

    it('conserve la passe globale catalog:rating (seul filet des titres sans année)', async () => {
      const planner = await makePlanner();

      const queue = planner.planQueue([], WEDNESDAY);
      const global = queue.find((s) => s.jobName === 'catalog:rating');

      expect(global).toBeDefined();
      expect(global?.kind).toBe('global');
      expect(global?.year).toBeUndefined();
      // Passe avant les shards annuels.
      expect(
        queue.findIndex((s) => s.jobName === 'catalog:rating'),
      ).toBeLessThan(queue.findIndex((s) => s.kind === 'year'));
    });

    it("n'inclut le shard hebdo week_pos que le dimanche", async () => {
      const planner = await makePlanner();

      const wednesday = planner.planQueue([], WEDNESDAY);
      const sunday = planner.planQueue([], SUNDAY);

      expect(wednesday.some((s) => s.jobName === 'catalog:week_pos')).toBe(
        false,
      );
      const weekly = sunday.find((s) => s.jobName === 'catalog:week_pos');
      expect(weekly).toBeDefined();
      // En tête de file (nouveautés d'abord) et plafonné à 10 pages.
      expect(sunday[0].jobName).toBe('catalog:week_pos');
      expect(weekly?.pageCap).toBe(10);
    });

    it('respecte CATALOG_SYNC_YEAR_FLOOR', async () => {
      const planner = await makePlanner({ CATALOG_SYNC_YEAR_FLOOR: '2000' });

      const years = planner
        .planQueue([], WEDNESDAY)
        .filter((s) => s.kind === 'year')
        .map((s) => s.year as number);

      expect(Math.min(...years)).toBe(2000);
    });
  });

  describe('reprise inter-shards', () => {
    it('exclut les shards terminés et frais, garde le premier inachevé', async () => {
      const planner = await makePlanner();
      const justNow = new Date(WEDNESDAY.getTime() - DAY_MS);

      // Nuit précédente : 2026 et 2025 terminés, 2024 entamé (page 12).
      const states = [
        state({ job_name: 'catalog:rating', completed_at: justNow }),
        state({ job_name: 'catalog:year:2026', completed_at: justNow }),
        state({ job_name: 'catalog:year:2025', completed_at: justNow }),
        state({ job_name: 'catalog:year:2024', last_completed_page: 12 }),
      ];

      const queue = planner.planQueue(states, WEDNESDAY);

      // La nuit suivante reprend exactement sur le shard laissé en cours.
      expect(queue[0].jobName).toBe('catalog:year:2024');
      expect(queue.map((s) => s.jobName)).not.toContain('catalog:year:2026');
      expect(queue.map((s) => s.jobName)).not.toContain('catalog:year:2025');
      expect(queue.map((s) => s.jobName)).not.toContain('catalog:rating');
    });

    it("un shard terminé reste au repos tant que sa fenêtre n'est pas écoulée", async () => {
      const planner = await makePlanner({
        CATALOG_SYNC_SHARD_REFRESH_DAYS: '30',
      });
      const states = [
        state({
          job_name: 'catalog:year:2000',
          completed_at: new Date(WEDNESDAY.getTime() - 29 * DAY_MS),
        }),
      ];

      const queue = planner.planQueue(states, WEDNESDAY);

      expect(queue.map((s) => s.jobName)).not.toContain('catalog:year:2000');
    });

    it('un shard terminé redevient éligible après sa fenêtre de rafraîchissement', async () => {
      const planner = await makePlanner({
        CATALOG_SYNC_SHARD_REFRESH_DAYS: '30',
      });
      const states = [
        state({
          job_name: 'catalog:year:2000',
          completed_at: new Date(WEDNESDAY.getTime() - 31 * DAY_MS),
        }),
      ];

      const queue = planner.planQueue(states, WEDNESDAY);

      expect(queue.map((s) => s.jobName)).toContain('catalog:year:2000');
    });

    it('les années récentes se rafraîchissent plus vite que les anciennes', async () => {
      const planner = await makePlanner({
        CATALOG_SYNC_SHARD_REFRESH_DAYS: '30',
      });
      const tenDaysAgo = new Date(WEDNESDAY.getTime() - 10 * DAY_MS);
      const states = [
        state({ job_name: 'catalog:year:2026', completed_at: tenDaysAgo }),
        state({ job_name: 'catalog:year:1990', completed_at: tenDaysAgo }),
      ];

      const names = planner.planQueue(states, WEDNESDAY).map((s) => s.jobName);

      // Année courante : fenêtre 7 j → déjà due. Année ancienne : 30 j → non.
      expect(names).toContain('catalog:year:2026');
      expect(names).not.toContain('catalog:year:1990');
    });

    it('un shard jamais tourné est toujours éligible', async () => {
      const planner = await makePlanner();

      const queue = planner.planQueue([], WEDNESDAY);

      expect(queue.length).toBeGreaterThan(90);
    });

    it('un arrêt partiel (completed_at null) reste éligible malgré un last_run_at récent', async () => {
      const planner = await makePlanner();
      const states = [
        state({
          job_name: 'catalog:year:2020',
          last_run_at: WEDNESDAY,
          last_run_status: 'partial',
          last_completed_page: 7,
          completed_at: null,
        }),
      ];

      const names = planner.planQueue(states, WEDNESDAY).map((s) => s.jobName);

      expect(names).toContain('catalog:year:2020');
    });
  });

  describe('saturation et sous-découpage', () => {
    it('détecte la saturation au plafond MU de 10 000', () => {
      expect(CatalogShardPlannerService.isSaturated(9_999)).toBe(false);
      expect(CatalogShardPlannerService.isSaturated(10_000)).toBe(true);
      expect(CatalogShardPlannerService.isSaturated(10_001)).toBe(true);
    });

    it('découpe une année saturée en un sous-shard par genre non-NSFW', async () => {
      const planner = await makePlanner();

      const subs = planner.expandSaturatedShard({
        jobName: 'catalog:year:2024',
        kind: 'year',
        level: 1,
        orderby: 'rating',
        year: 2024,
      });

      expect(subs).toHaveLength(MU_SHARDABLE_GENRES.length);
      expect(subs[0].jobName).toBe('catalog:year:2024:genre:Action');
      expect(subs[0].year).toBe(2024);
      expect(subs[0].genre).toBe('Action');
      expect(subs.every((s) => s.level === 2)).toBe(true);
      // Les genres NSFW sont déjà exclus de toutes les requêtes : les
      // sous-shards correspondants seraient systématiquement vides.
      for (const nsfw of NSFW_GENRES) {
        expect(subs.map((s) => s.genre)).not.toContain(nsfw);
      }
    });

    it('ne re-découpe PAS un sous-shard de niveau 2 (récursion limitée)', async () => {
      const planner = await makePlanner();

      const subs = planner.expandSaturatedShard({
        jobName: 'catalog:year:2024:genre:Action',
        kind: 'year_genre',
        level: 2,
        orderby: 'rating',
        year: 2024,
        genre: 'Action',
      });

      expect(subs).toEqual([]);
    });

    it('planifie les sous-shards juste après une année marquée saturée', async () => {
      const planner = await makePlanner();
      const states = [
        state({ job_name: 'catalog:year:2024', saturated: true }),
      ];

      const queue = planner.planQueue(states, WEDNESDAY);
      const names = queue.map((s) => s.jobName);
      const yearIndex = names.indexOf('catalog:year:2024');

      expect(names[yearIndex + 1]).toBe('catalog:year:2024:genre:Action');
      expect(names).toContain('catalog:year:2024:genre:Romance');
      // L'année suivante du parcours arrive APRÈS tous les sous-shards.
      expect(names.indexOf('catalog:year:2023')).toBe(
        yearIndex + MU_SHARDABLE_GENRES.length + 1,
      );
    });

    it("n'ajoute pas de sous-shards pour une année non saturée", async () => {
      const planner = await makePlanner();

      const names = planner.planQueue([], WEDNESDAY).map((s) => s.jobName);

      expect(names.some((n) => n.includes(':genre:'))).toBe(false);
    });
  });
});
