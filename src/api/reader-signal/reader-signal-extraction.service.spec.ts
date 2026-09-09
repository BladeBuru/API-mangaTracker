import { ConfigService } from '@nestjs/config';
import { ReaderSignalExtractionService } from './reader-signal-extraction.service';
import {
  emptyOutcome,
  ReaderSignalOutcome,
  ReaderSignalRunBudget,
} from './reader-signal-run';

const HASH = 'a'.repeat(64);

function config(overrides: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => overrides[key] } as unknown as ConfigService;
}

describe('ReaderSignalExtractionService', () => {
  let service: ReaderSignalExtractionService;
  let outcome: ReaderSignalOutcome;
  let budget: ReaderSignalRunBudget;
  let profiles: Array<{ status: string; lists: number; rows: number }>;
  let writtenCount: number;

  let listsResult: () => Promise<unknown>;
  let pageResult: (page: number) => Promise<unknown>;

  beforeEach(() => {
    profiles = [];
    writtenCount = 0;
    outcome = emptyOutcome(100);
    budget = new ReaderSignalRunBudget(100, 5, 0, () => Promise.resolve());
    listsResult = () =>
      Promise.resolve([{ listId: '2', listType: 'complete' }]);
    pageResult = () =>
      Promise.resolve({
        rows: [{ muId: '1', listType: 'complete', rating: null }],
        totalHits: 1,
        perPageEcho: 1000,
      });

    const client = {
      fetchPublicLists: jest.fn(() => listsResult()),
      fetchListPage: jest.fn(
        (_u: string, _l: string, _t: string, page: number) => pageResult(page),
      ),
    };
    const writer = {
      knownSeries: jest.fn((ids: string[]) =>
        Promise.resolve(new Map(ids.map((id) => [id, 'Manhwa']))),
      ),
      writeSignal: jest.fn((rows: unknown[]) => {
        writtenCount += rows.length;
        return Promise.resolve({
          written: rows.length,
          withRating: 0,
          unknownSeries: 0,
          byMangaType: rows.length > 0 ? { Manhwa: rows.length } : {},
        });
      }),
      recordProfile: jest.fn(
        (_h: string, status: string, lists: number, rows: number) => {
          profiles.push({ status, lists, rows });
          return Promise.resolve();
        },
      ),
    };
    service = new ReaderSignalExtractionService(
      client as never,
      writer as never,
      config(),
    );
  });

  it('écrit les lignes et journalise le lecteur comme collecté', async () => {
    await service.extractReader('900', HASH, outcome, budget);
    expect(outcome.readersExtracted).toBe(1);
    expect(writtenCount).toBe(1);
    expect(profiles).toEqual([{ status: 'collected', lists: 1, rows: 1 }]);
  });

  it('marque « empty » un compte sans liste publique, sans le pénaliser', async () => {
    listsResult = () => Promise.resolve([]);
    await service.extractReader('900', HASH, outcome, budget);
    expect(outcome.readersEmpty).toBe(1);
    expect(outcome.readersFailed).toBe(0);
    expect(profiles[0].status).toBe('empty');
  });

  it('marque « failed » quand les listes sont illisibles', async () => {
    listsResult = () => Promise.reject(new Error('MU down'));
    await service.extractReader('900', HASH, outcome, budget);
    expect(outcome.readersFailed).toBe(1);
    expect(profiles[0].status).toBe('failed');
    expect(writtenCount).toBe(0);
  });

  it('conserve ce qui a été lu avant un échec en cours de route', async () => {
    // Deux listes, la seconde échoue : le contenu de la première est acquis
    // et ne doit pas être re-payé au prochain run.
    listsResult = () =>
      Promise.resolve([
        { listId: '2', listType: 'complete' },
        { listId: '0', listType: 'read' },
      ]);
    let call = 0;
    pageResult = () => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          rows: [{ muId: '1', listType: 'complete', rating: 9 }],
          totalHits: 1,
          perPageEcho: 1000,
        });
      }
      return Promise.reject(new Error('MU down'));
    };
    await service.extractReader('900', HASH, outcome, budget);
    expect(writtenCount).toBe(1);
    expect(outcome.readersExtracted).toBe(1);
    expect(profiles[0].status).toBe('collected');
  });

  it('ne dépasse pas le budget restant', async () => {
    budget = new ReaderSignalRunBudget(1, 5, 0, () => Promise.resolve());
    listsResult = () =>
      Promise.resolve([
        { listId: '2', listType: 'complete' },
        { listId: '0', listType: 'read' },
      ]);
    await service.extractReader('900', HASH, outcome, budget);
    // 1 requête pour les listes : plus rien ne reste pour leur contenu.
    expect(budget.used).toBe(1);
    expect(writtenCount).toBe(0);
  });

  it('n’émet pas de seconde requête quand la note d’une liste est masquée', async () => {
    // `show_rating` désactivé côté MU : les lignes arrivent sans note, ce
    // n'est pas une raison de re-demander la page.
    pageResult = () =>
      Promise.resolve({
        rows: [{ muId: '1', listType: 'complete', rating: null }],
        totalHits: 1,
        perPageEcho: 1000,
      });
    await service.extractReader('900', HASH, outcome, budget);
    expect(budget.used).toBe(2);
  });
});
