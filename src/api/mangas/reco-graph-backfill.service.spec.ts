import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { of, throwError } from 'rxjs';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { Manga } from './manga.entity';
import { MuJobLockService } from './mu-job-lock.service';
import { RecoGraphBackfillService } from './reco-graph-backfill.service';
import { RecoGraphIngestService } from './reco-graph-ingest.service';

describe('RecoGraphBackfillService', () => {
  let service: RecoGraphBackfillService;
  let stateRepo: { findOneBy: jest.Mock; create: jest.Mock; save: jest.Mock };
  let mangaRepo: { createQueryBuilder: jest.Mock; update: jest.Mock };
  let ingestService: { ingestSeriesPayload: jest.Mock };
  let lock: MuJobLockService;
  let httpGet: jest.Mock;
  let targets: { mu_id: string }[];
  let eligibleCount: number;
  let selectQb: Record<string, jest.Mock>;

  /** Concatène les fragments SQL passés à where/orderBy. */
  function sqlFragments(): string {
    return [
      ...selectQb.where.mock.calls.map((c) => String(c[0])),
      ...selectQb.orderBy.mock.calls.map((c) => String(c[0])),
    ].join(' | ');
  }

  beforeEach(async () => {
    targets = [];
    eligibleCount = 0;
    httpGet = jest.fn(() => of({ data: { recommendations: [] } }));

    selectQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn(async () => targets),
      getCount: jest.fn(async () => eligibleCount),
    };

    stateRepo = {
      findOneBy: jest.fn().mockResolvedValue(null),
      create: jest.fn((partial: Partial<CatalogSyncState>) =>
        Object.assign(new CatalogSyncState(), partial),
      ),
      save: jest.fn((s: CatalogSyncState) => Promise.resolve(s)),
    };
    mangaRepo = {
      createQueryBuilder: jest.fn(() => selectQb),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    ingestService = {
      ingestSeriesPayload: jest.fn(async () => ({
        manual: 1,
        category: 5,
        related: 2,
        stubs: 8,
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecoGraphBackfillService,
        MuJobLockService,
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
        { provide: HttpService, useValue: { get: httpGet } },
        { provide: RecoGraphIngestService, useValue: ingestService },
      ],
    }).compile();

    service = module.get<RecoGraphBackfillService>(RecoGraphBackfillService);
    lock = module.get<MuJobLockService>(MuJobLockService);
    service.sleep = jest.fn().mockResolvedValue(undefined);
  });

  describe('budget', () => {
    it('ne demande jamais plus de fiches que le budget du run', async () => {
      targets = [{ mu_id: '1' }, { mu_id: '2' }];
      eligibleCount = 5000;

      const outcome = await service.runOnce(2);

      expect(selectQb.limit).toHaveBeenCalledWith(2);
      expect(outcome?.attempted).toBe(2);
      expect(httpGet).toHaveBeenCalledTimes(2);
    });

    it('utilise `RECO_GRAPH_BACKFILL_PAGES_PER_RUN` (défaut 1 500)', async () => {
      targets = [];
      await service.runOnce();
      expect(selectQb.limit).toHaveBeenCalledWith(1500);
    });
  });

  describe('priorisation', () => {
    it('ordonne bibliothèques, puis cibles déjà recommandées, puis accueil, puis note', async () => {
      targets = [{ mu_id: '1' }];
      await service.runOnce();

      const sql = sqlFragments();
      expect(sql).toContain('reco_graph_attempted_at');
      expect(sql.indexOf('user_manga')).toBeLessThan(
        sql.indexOf('manga_recommendation'),
      );
      expect(sql.indexOf('manga_recommendation')).toBeLessThan(
        sql.indexOf('medium_cover_url'),
      );
      expect(selectQb.addOrderBy).toHaveBeenCalledWith(
        'm.rating',
        'DESC',
        'NULLS LAST',
      );
    });
  });

  describe('verrou MU partagé', () => {
    it('se retire si un autre job MU tourne (skip, jamais attendre)', async () => {
      targets = [{ mu_id: '1' }];
      lock.tryAcquire('catalog');

      const outcome = await service.runOnce();

      expect(outcome).toBeNull();
      expect(httpGet).not.toHaveBeenCalled();
    });

    it('libère le verrou en fin de run, même après une erreur', async () => {
      targets = [{ mu_id: '1' }];
      selectQb.getCount.mockRejectedValueOnce(new Error('base HS'));

      await expect(service.runOnce()).rejects.toThrow('base HS');
      expect(lock.current).toBeNull();
    });
  });

  describe('filigrane et reprise', () => {
    it('horodate la tentative même en cas d’échec MU', async () => {
      targets = [{ mu_id: '7' }];
      httpGet.mockReturnValue(
        throwError(() => Object.assign(new Error('boom'), { response: {} })),
      );

      const outcome = await service.runOnce();

      expect(outcome?.ingested).toBe(0);
      expect(mangaRepo.update).toHaveBeenCalledWith(
        { mu_id: '7' },
        expect.objectContaining({ reco_graph_attempted_at: expect.any(Date) }),
      );
    });

    it('persiste le curseur cumulé dans `catalog_sync_state`', async () => {
      targets = [{ mu_id: '1' }, { mu_id: '2' }];
      eligibleCount = 42;
      stateRepo.findOneBy.mockResolvedValue(
        Object.assign(new CatalogSyncState(), {
          job_name: 'reco-graph',
          last_completed_page: 10,
          consecutive_failures: 0,
        }),
      );

      await service.runOnce();

      const saved = stateRepo.save.mock.calls[0][0] as CatalogSyncState;
      expect(saved.job_name).toBe('reco-graph');
      expect(saved.last_completed_page).toBe(12);
      expect(saved.total_pages).toBe(42);
      expect(saved.last_run_status).toBe('completed');
    });

    it('remet le curseur à 0 et horodate `completed_at` quand tout est couvert', async () => {
      targets = [];
      eligibleCount = 0;

      const outcome = await service.runOnce();

      expect(outcome?.attempted).toBe(0);
      const saved = stateRepo.save.mock.calls[0][0] as CatalogSyncState;
      expect(saved.last_completed_page).toBe(0);
      expect(saved.completed_at).toBeInstanceOf(Date);
      expect(httpGet).not.toHaveBeenCalled();
    });
  });

  describe('disjoncteur', () => {
    it('interrompt le run après 5 fiches consécutives en échec', async () => {
      targets = Array.from({ length: 20 }, (_, i) => ({
        mu_id: String(i + 1),
      }));
      httpGet.mockReturnValue(
        throwError(() => Object.assign(new Error('boom'), { response: {} })),
      );

      const outcome = await service.runOnce();

      expect(outcome?.circuitBroken).toBe(true);
      expect(outcome?.attempted).toBe(5);
      const saved = stateRepo.save.mock.calls[0][0] as CatalogSyncState;
      expect(saved.last_run_status).toBe('partial');
      expect(saved.consecutive_failures).toBe(1);
    });

    it('remet le compteur à zéro dès qu’une fiche passe', async () => {
      targets = Array.from({ length: 12 }, (_, i) => ({
        mu_id: String(i + 1),
      }));
      let call = 0;
      httpGet.mockImplementation(() => {
        call += 1;
        // 4 échecs, 1 succès, puis 4 échecs : jamais 5 d'affilée.
        return call === 5 || call > 9
          ? of({ data: {} })
          : throwError(() =>
              Object.assign(new Error('boom'), { response: {} }),
            );
      });

      const outcome = await service.runOnce();

      expect(outcome?.circuitBroken).toBe(false);
      expect(outcome?.attempted).toBe(12);
    });
  });

  it('compte les liens écrits sur les fiches ingérées', async () => {
    targets = [{ mu_id: '1' }, { mu_id: '2' }];

    const outcome = await service.runOnce();

    expect(outcome?.ingested).toBe(2);
    expect(outcome?.links).toBe(16);
    expect(ingestService.ingestSeriesPayload).toHaveBeenCalledWith(1, {
      recommendations: [],
    });
  });

  it('ne tourne pas quand le job est désactivé (cron)', async () => {
    targets = [{ mu_id: '1' }];
    await service.handleNightlyBackfill();
    expect(httpGet).not.toHaveBeenCalled();
  });
});
