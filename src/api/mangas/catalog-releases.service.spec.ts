import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { of, Subject, throwError } from 'rxjs';
import { CatalogReleasesService } from './catalog-releases.service';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { Manga } from './manga.entity';
import { ReadingStatusAutoUpdateService } from '@/api/library/reading-status-auto-update.service';

/** Un UPDATE `manga` capturé, tel qu'il partirait vers PostgreSQL. */
interface UpdateCall {
  setPayload: Record<string, unknown>;
  newTotal: number;
  muId: string;
  /** Clauses `andWhere` brutes (garde « le total a-t-il vraiment monté ? »). */
  andWheres: string[];
}

/** Réponse `releases/search` : `count` sorties, time_added décroissant. */
function muReleasesPage(opts: {
  seriesIds: number[];
  chapters?: string[];
  startTs: number;
  totalHits?: number;
}) {
  const { seriesIds, startTs } = opts;
  return {
    data: {
      total_hits: opts.totalHits ?? 10000,
      page: 1,
      per_page: 100,
      results: seriesIds.map((seriesId, i) => ({
        record: {
          id: 1262426 - i,
          title: `Serie ${seriesId}`,
          volume: null,
          chapter: opts.chapters?.[i] ?? String(10 + i),
          // Décroissant, comme le vrai tri `orderby: 'time'`.
          time_added: { timestamp: startTs - i },
        },
        metadata: { series: { series_id: seriesId } },
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

/**
 * Tests du job nocturne des dernières sorties (`CatalogReleasesService`).
 *
 * Couvre les garanties qui protègent réellement l'utilisateur :
 * incrémentalité du curseur, monotonie de `total_chapters`, absence de
 * création de séries, et politique réseau (backoff, plafond de pages).
 */
describe('CatalogReleasesService', () => {
  let service: CatalogReleasesService;
  let postMock: jest.Mock;
  let stateRepo: { findOneBy: jest.Mock; create: jest.Mock; save: jest.Mock };
  let mangaRepo: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let statusAutoUpdate: { flipCaughtUpToReading: jest.Mock };
  let updateCalls: UpdateCall[];
  let sleepMock: jest.Mock;
  let savedState: CatalogSyncState;
  /**
   * Lignes `manga` touchées par le prochain UPDATE, par mu_id. Par défaut 1
   * (le total monte) ; 0 simule une sortie déjà connue (GREATEST sans effet).
   */
  let affectedByMuId: Record<string, number>;

  /** Déclare les mu_id que la base est censée connaître. */
  function dbKnows(...muIds: string[]): void {
    mangaRepo.find.mockImplementation(() =>
      Promise.resolve(muIds.map((mu_id) => ({ mu_id }))),
    );
  }

  function makeUpdateQb() {
    const captured: Partial<UpdateCall> = { andWheres: [] };
    const qb = {
      update: jest.fn(() => qb),
      set: jest.fn((payload: Record<string, unknown>) => {
        captured.setPayload = payload;
        return qb;
      }),
      setParameter: jest.fn((key: string, value: number) => {
        if (key === 'newTotal') captured.newTotal = value;
        return qb;
      }),
      where: jest.fn((_sql: string, params: { muId: string }) => {
        captured.muId = params.muId;
        return qb;
      }),
      andWhere: jest.fn((sql: string) => {
        captured.andWheres.push(sql);
        return qb;
      }),
      execute: jest.fn(() => {
        const muId = captured.muId ?? '';
        updateCalls.push({
          setPayload: captured.setPayload ?? {},
          newTotal: captured.newTotal ?? -1,
          muId,
          andWheres: captured.andWheres,
        });
        return Promise.resolve({ affected: affectedByMuId[muId] ?? 1 });
      }),
    };
    return qb;
  }

  async function build(config: Record<string, string> = {}): Promise<void> {
    updateCalls = [];
    affectedByMuId = {};
    postMock = jest.fn();
    sleepMock = jest.fn().mockResolvedValue(undefined);
    statusAutoUpdate = { flipCaughtUpToReading: jest.fn(async () => 0) };

    savedState = Object.assign(new CatalogSyncState(), {
      job_name: 'releases',
      last_completed_page: 0,
      consecutive_failures: 0,
      cursor_time_added: null,
    });

    stateRepo = {
      // Par défaut le job a déjà tourné, avec un curseur bas : les fixtures
      // de ces tests utilisent de petits timestamps pour rester lisibles.
      // Les tests du tout premier run remettent explicitement `null`.
      findOneBy: jest.fn().mockResolvedValue(
        Object.assign(new CatalogSyncState(), {
          job_name: 'releases',
          consecutive_failures: 0,
          cursor_time_added: '1000',
        }),
      ),
      create: jest.fn((partial: Partial<CatalogSyncState>) =>
        Object.assign(new CatalogSyncState(), partial),
      ),
      save: jest.fn((state: CatalogSyncState) => {
        savedState = state;
        return Promise.resolve(state);
      }),
    };

    mangaRepo = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => makeUpdateQb()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogReleasesService,
        { provide: HttpService, useValue: { post: postMock } },
        {
          provide: getRepositoryToken(CatalogSyncState),
          useValue: stateRepo,
        },
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
        { provide: ReadingStatusAutoUpdateService, useValue: statusAutoUpdate },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({ RELEASES_SYNC_ENABLED: 'true', ...config }[key]),
          },
        },
      ],
    }).compile();

    service = module.get<CatalogReleasesService>(CatalogReleasesService);
    service.sleep = sleepMock as unknown as (ms: number) => Promise<void>;
  }

  beforeEach(async () => {
    await build();
  });

  describe('appel MU', () => {
    it('should request include_metadata — without it there is no series id at all', async () => {
      postMock.mockReturnValue(
        of(muReleasesPage({ seriesIds: [], startTs: 0 })),
      );

      await service.runOnce();

      const [, payload] = postMock.mock.calls[0];
      expect(payload.include_metadata).toBe(true);
      // `orderby: 'time'` = tri par time_added. `release_date` contient des
      // dates aberrantes et ne peut pas servir de curseur.
      expect(payload.orderby).toBe('time');
      expect(payload.perpage).toBe(100);
    });
  });

  describe('incrémentalité du curseur', () => {
    it('should only process releases newer than the persisted cursor', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        Object.assign(new CatalogSyncState(), {
          job_name: 'releases',
          consecutive_failures: 0,
          cursor_time_added: '1000',
        }),
      );
      dbKnows('111', '222', '333');
      // 1002 et 1001 sont neufs ; 1000 et 999 ont déjà été vus.
      postMock.mockReturnValue(
        of(
          muReleasesPage({
            seriesIds: [111, 222, 333, 444],
            chapters: ['5', '6', '7', '8'],
            startTs: 1002,
          }),
        ),
      );

      await service.runOnce();

      expect(updateCalls.map((c) => c.muId)).toEqual(['111', '222']);
    });

    it('should advance the cursor to the newest timestamp seen', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        Object.assign(new CatalogSyncState(), {
          job_name: 'releases',
          consecutive_failures: 0,
          cursor_time_added: '1000',
        }),
      );
      dbKnows('111');
      postMock.mockReturnValue(
        of(muReleasesPage({ seriesIds: [111, 222], startTs: 5000 })),
      );

      await service.runOnce();

      expect(savedState.cursor_time_added).toBe('5000');
      expect(savedState.last_run_status).toBe('completed');
    });

    it('should re-run idempotently: a second pass writes nothing new', async () => {
      dbKnows('111');
      postMock.mockReturnValue(
        of(muReleasesPage({ seriesIds: [111], startTs: 5000 })),
      );

      await service.runOnce();
      const afterFirst = updateCalls.length;
      expect(afterFirst).toBe(1);

      // 2e nuit : le curseur persisté couvre déjà cette sortie.
      stateRepo.findOneBy.mockResolvedValue(savedState);
      await service.runOnce();

      expect(updateCalls).toHaveLength(afterFirst);
    });

    it('should fall back to a BOUNDED lookback window on the very first run', async () => {
      // Curseur null : on ne remonte pas tout l'historique MU (plafonné à
      // 10 000 hits de toute façon), on se limite à N jours.
      await build({ RELEASES_SYNC_LOOKBACK_DAYS: '7' });
      stateRepo.findOneBy.mockResolvedValue(null);
      const nowSec = Math.floor(Date.now() / 1000);
      dbKnows('111', '222');
      postMock.mockReturnValue(
        of({
          data: {
            total_hits: 100,
            results: [
              {
                record: {
                  id: 1,
                  chapter: '5',
                  time_added: { timestamp: nowSec },
                },
                metadata: { series: { series_id: 111 } },
              },
              {
                record: {
                  id: 2,
                  chapter: '6',
                  // 8 jours → hors de la fenêtre de 7 jours.
                  time_added: { timestamp: nowSec - 8 * 24 * 3600 },
                },
                metadata: { series: { series_id: 222 } },
              },
            ],
          },
        }),
      );

      await service.runOnce();

      expect(updateCalls.map((c) => c.muId)).toEqual(['111']);
    });
  });

  describe('monotonie de total_chapters (invariant A-5)', () => {
    it('should write total_chapters through GREATEST, never a plain assignment', async () => {
      dbKnows('111');
      postMock.mockReturnValue(
        of(
          muReleasesPage({
            seriesIds: [111],
            chapters: ['42'],
            startTs: 5000,
          }),
        ),
      );

      await service.runOnce();

      expect(updateCalls).toHaveLength(1);
      const setter = updateCalls[0].setPayload.total_chapters;
      expect(typeof setter).toBe('function');
      expect((setter as () => string)()).toBe(
        'GREATEST(total_chapters, :newTotal)',
      );
      expect(updateCalls[0].newTotal).toBe(42);
    });

    it('should never touch any column other than total_chapters', async () => {
      dbKnows('111');
      postMock.mockReturnValue(
        of(muReleasesPage({ seriesIds: [111], startTs: 5000 })),
      );

      await service.runOnce();

      expect(Object.keys(updateCalls[0].setPayload)).toEqual([
        'total_chapters',
      ]);
    });

    it('should guard the UPDATE with total_chapters < :newTotal to learn whether the total really grew', async () => {
      dbKnows('111');
      postMock.mockReturnValue(
        of(muReleasesPage({ seriesIds: [111], startTs: 5000 })),
      );

      await service.runOnce();

      expect(updateCalls[0].andWheres).toEqual(['total_chapters < :newTotal']);
    });

    it('should send the HIGHEST chapter when a series released several times', async () => {
      dbKnows('111');
      postMock.mockReturnValue(
        of(
          muReleasesPage({
            seriesIds: [111, 111, 111],
            chapters: ['10', '12', '11'],
            startTs: 5000,
          }),
        ),
      );

      await service.runOnce();

      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].newTotal).toBe(12);
    });
  });

  describe('bascule « à jour » → « en cours » (nouveaux chapitres)', () => {
    it('should flip caught-up readers ONLY for series whose total actually grew', async () => {
      dbKnows('111', '222');
      // 111 : total monte (1 ligne touchée). 222 : sortie d'un chapitre déjà
      // couvert par le total en base → GREATEST sans effet (0 ligne).
      affectedByMuId = { '111': 1, '222': 0 };
      statusAutoUpdate.flipCaughtUpToReading.mockResolvedValue(2);
      postMock.mockReturnValue(
        of(
          muReleasesPage({
            seriesIds: [111, 222],
            chapters: ['40', '7'],
            startTs: 5000,
          }),
        ),
      );

      const outcome = await service.runOnce();

      expect(statusAutoUpdate.flipCaughtUpToReading).toHaveBeenCalledTimes(1);
      expect(statusAutoUpdate.flipCaughtUpToReading).toHaveBeenCalledWith(
        '111',
      );
      // Une requête ensembliste par série, comptée dans le bilan du run.
      expect(outcome?.statusFlips).toBe(2);
      // Les deux séries restent « mises à jour » au sens du job (connues).
      expect(outcome?.seriesUpdated).toBe(2);
    });

    it('should never flip for an unknown series (no UPDATE at all)', async () => {
      dbKnows();
      postMock.mockReturnValue(
        of(muReleasesPage({ seriesIds: [999], startTs: 5000 })),
      );

      const outcome = await service.runOnce();

      expect(statusAutoUpdate.flipCaughtUpToReading).not.toHaveBeenCalled();
      expect(outcome?.statusFlips).toBe(0);
    });
  });

  describe('aucune création de série', () => {
    it('should ignore series absent from the DB instead of inserting stubs', async () => {
      dbKnows('111');
      postMock.mockReturnValue(
        of(muReleasesPage({ seriesIds: [111, 999], startTs: 5000 })),
      );

      const outcome = await service.runOnce();

      expect(updateCalls.map((c) => c.muId)).toEqual(['111']);
      expect(outcome?.seriesUnknown).toBe(1);
      // Aucun insert : seul le query builder d'UPDATE est utilisé.
      expect(mangaRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    });
  });

  describe('pagination et budget réseau', () => {
    it('should stop as soon as a page holds nothing newer than the cursor', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        Object.assign(new CatalogSyncState(), {
          job_name: 'releases',
          consecutive_failures: 0,
          cursor_time_added: '4999',
        }),
      );
      dbKnows('111');
      postMock.mockReturnValue(
        of(muReleasesPage({ seriesIds: [111, 222], startTs: 5000 })),
      );

      await service.runOnce();

      // La page contient du déjà-vu → inutile d'aller chercher plus vieux.
      expect(postMock).toHaveBeenCalledTimes(1);
    });

    it('should keep paginating while every record of a page is fresh', async () => {
      dbKnows();
      let page = 0;
      postMock.mockImplementation(() => {
        page += 1;
        // Pages 1-2 pleines et fraîches, page 3 vide → arrêt.
        if (page >= 3) return of({ data: { total_hits: 0, results: [] } });
        return of(
          muReleasesPage({
            seriesIds: Array.from({ length: 100 }, (_, i) => 1000 + i),
            startTs: 9_000_000_000 - page * 1000,
          }),
        );
      });

      await service.runOnce();

      expect(postMock).toHaveBeenCalledTimes(3);
    });

    it('should honour RELEASES_SYNC_MAX_PAGES as a hard ceiling', async () => {
      await build({ RELEASES_SYNC_MAX_PAGES: '3' });
      dbKnows();
      // Toutes les pages sont pleines et fraîches : sans plafond, le job
      // paginerait indéfiniment et frapperait MU sans fin.
      postMock.mockImplementation(() =>
        of(
          muReleasesPage({
            seriesIds: Array.from({ length: 100 }, (_, i) => 1000 + i),
            startTs: 9_000_000_000,
          }),
        ),
      );

      await service.runOnce();

      expect(postMock).toHaveBeenCalledTimes(3);
    });

    it('should pace requests with the shared MU delay', async () => {
      await build({ CATALOG_SYNC_DELAY_MS: '2000' });
      dbKnows();
      let page = 0;
      postMock.mockImplementation(() => {
        page += 1;
        if (page >= 2) return of({ data: { total_hits: 0, results: [] } });
        return of(
          muReleasesPage({
            seriesIds: Array.from({ length: 100 }, (_, i) => 1000 + i),
            startTs: 9_000_000_000,
          }),
        );
      });

      await service.runOnce();

      expect(sleepMock).toHaveBeenCalledWith(2000);
    });
  });

  describe('non-régression du backoff MU', () => {
    it('should retry a 429 with the 5/10/20/40 s ladder', async () => {
      dbKnows('111');
      let call = 0;
      postMock.mockImplementation(() => {
        call += 1;
        if (call === 1) return throwError(() => axiosError(429));
        return of(muReleasesPage({ seriesIds: [111], startTs: 5000 }));
      });

      await service.runOnce();

      expect(sleepMock).toHaveBeenCalledWith(5000);
      expect(updateCalls).toHaveLength(1);
    });

    it('should give up after 4 retries and keep the cursor untouched', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        Object.assign(new CatalogSyncState(), {
          job_name: 'releases',
          consecutive_failures: 0,
          cursor_time_added: '1000',
        }),
      );
      postMock.mockReturnValue(throwError(() => axiosError(500)));

      const outcome = await service.runOnce();

      expect(postMock).toHaveBeenCalledTimes(5); // 1 + 4 retries
      expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([
        5000, 10000, 20000, 40000,
      ]);
      expect(outcome?.failed).toBe(true);
      // Le curseur NE bouge PAS : avancer après un échec en cours de
      // pagination enterrerait les sorties non traitées (les plus anciennes).
      expect(savedState.cursor_time_added).toBe('1000');
      expect(savedState.last_run_status).toBe('partial');
      expect(savedState.consecutive_failures).toBe(1);
    });

    it('should not retry a non-retryable 400', async () => {
      postMock.mockReturnValue(throwError(() => axiosError(400)));

      await service.runOnce();

      expect(postMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).not.toHaveBeenCalled();
    });

    it('should keep the cursor untouched when a DB write fails mid-run', async () => {
      stateRepo.findOneBy.mockResolvedValue(
        Object.assign(new CatalogSyncState(), {
          job_name: 'releases',
          consecutive_failures: 0,
          cursor_time_added: '1000',
        }),
      );
      dbKnows('111');
      mangaRepo.createQueryBuilder.mockImplementation(() => {
        const qb = makeUpdateQb();
        qb.execute = jest.fn(() => Promise.reject(new Error('DB down')));
        return qb;
      });
      postMock.mockReturnValue(
        of(muReleasesPage({ seriesIds: [111], startTs: 5000 })),
      );

      const outcome = await service.runOnce();

      expect(outcome?.failed).toBe(true);
      expect(savedState.cursor_time_added).toBe('1000');
    });
  });

  describe('anti-réentrance', () => {
    it('should skip a run while another is still in flight', async () => {
      dbKnows();
      // Sujet non résolu : le 1er run reste bloqué sur l'appel MU.
      const pending = new Subject<unknown>();
      postMock.mockReturnValue(pending.asObservable());

      const first = service.runOnce();
      const second = await service.runOnce();

      expect(second).toBeNull();

      pending.next({ data: { total_hits: 0, results: [] } });
      pending.complete();
      await first;
    });
  });
});
