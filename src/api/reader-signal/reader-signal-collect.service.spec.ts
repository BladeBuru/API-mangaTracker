import { ConfigService } from '@nestjs/config';
import { MuJobLockService } from '@/api/mangas/mu-job-lock.service';
import { DiscoveredReader, PublicListRef } from './mu-lists.mapper';
import { ReaderSignalCollectService } from './reader-signal-collect.service';
import { ReaderSignalExtractionService } from './reader-signal-extraction.service';
import { DiscoveryTarget } from './reader-signal-priority.service';
import { PersistableSignalRow } from './reader-signal-writer.service';
import { READER_LIST_TYPES } from './reader-signal-weights';

const SALT = 's'.repeat(40);

function config(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    READER_SIGNAL_ENABLED: 'true',
    READER_SIGNAL_HASH_SALT: SALT,
    CATALOG_SYNC_DELAY_MS: '2000',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/** Cible de découverte fictive. */
function target(muId: string, bucket = 'Manhwa'): DiscoveryTarget {
  return { muId, mangaType: bucket, bucket };
}

describe('ReaderSignalCollectService', () => {
  let service: ReaderSignalCollectService;
  let lock: MuJobLockService;
  let sleeps: number[];

  // Doublures
  let similarByKey: Record<string, DiscoveredReader[]>;
  let similarErrors: Record<string, Error>;
  let listsByUser: Record<string, PublicListRef[]>;
  let listPages: Record<string, { rows: unknown[]; totalHits: number }>;
  let freshHashes: Set<string>;
  let writtenRows: PersistableSignalRow[];
  let profiles: Array<{ hash: string; status: string }>;
  let cursorsAdvanced: Array<{ bucket: string; consumed: number }>;
  let queue: DiscoveryTarget[];

  let similarCalls: string[];
  let listsCalls: string[];
  let pageCalls: string[];

  function build(overrides: Record<string, string> = {}): void {
    similarCalls = [];
    listsCalls = [];
    pageCalls = [];
    sleeps = [];

    const client = {
      fetchSimilarReaders: jest.fn((type: string, muId: string) => {
        const key = `${type}:${muId}`;
        similarCalls.push(key);
        if (similarErrors[key]) return Promise.reject(similarErrors[key]);
        return Promise.resolve(similarByKey[key] ?? []);
      }),
      fetchPublicLists: jest.fn((userId: string) => {
        listsCalls.push(userId);
        return Promise.resolve(listsByUser[userId] ?? []);
      }),
      fetchListPage: jest.fn(
        (
          userId: string,
          listId: string,
          listType: string,
          page: number,
          perPage: number,
        ) => {
          pageCalls.push(`${userId}/${listId}/${page}`);
          const found = listPages[`${userId}/${listId}`];
          return Promise.resolve({
            rows: (found?.rows ?? []).map((muId) => ({
              muId,
              listType,
              rating: null,
            })),
            totalHits: found?.totalHits ?? (found?.rows ?? []).length,
            // MU renvoie le perpage réellement appliqué : c'est lui qui sert
            // à décider du nombre de pages restantes.
            perPageEcho: perPage,
          });
        },
      ),
    };
    const hasher = {
      isConfigured: true,
      hash: (id: string | number) => `hash-${id}`,
    };
    const priority = {
      buildQueue: jest.fn(() =>
        Promise.resolve({
          targets: queue,
          cursors: [
            { bucket: 'Manhwa', offset: 0, depth: 1500, exhausted: false },
          ],
        }),
      ),
      advanceCursor: jest.fn((cursor: { bucket: string }, consumed: number) => {
        cursorsAdvanced.push({ bucket: cursor.bucket, consumed });
        return Promise.resolve();
      }),
    };
    const writer = {
      writeSignal: jest.fn((rows: PersistableSignalRow[]) => {
        writtenRows.push(...rows);
        return Promise.resolve({
          written: rows.length,
          withRating: rows.filter((r) => r.rating !== null).length,
          unknownSeries: 0,
          byMangaType: rows.length > 0 ? { Manhwa: rows.length } : {},
        });
      }),
      knownSeries: jest.fn((muIds: string[]) =>
        Promise.resolve(new Map(muIds.map((id) => [id, 'Manhwa']))),
      ),
      findFreshReaders: jest.fn(() => Promise.resolve(freshHashes)),
      recordProfile: jest.fn((hash: string, status: string) => {
        profiles.push({ hash, status });
        return Promise.resolve();
      }),
    };
    lock = new MuJobLockService();
    // L'étage d'extraction est le VRAI service : le job orchestre, il ne
    // duplique pas la logique de lecture des listes.
    const extraction = new ReaderSignalExtractionService(
      client as never,
      writer as never,
      config(overrides),
    );
    service = new ReaderSignalCollectService(
      client as never,
      hasher as never,
      priority as never,
      writer as never,
      extraction,
      lock,
      config(overrides),
    );
    service.sleep = jest.fn((ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    });
  }

  beforeEach(() => {
    similarByKey = {};
    similarErrors = {};
    listsByUser = {};
    listPages = {};
    freshHashes = new Set();
    writtenRows = [];
    profiles = [];
    cursorsAdvanced = [];
    queue = [];
    build();
  });

  describe('verrou MU partagé', () => {
    it('se retire si un autre job MU tient le verrou', async () => {
      lock.tryAcquire('catalogue');
      expect(await service.runOnce()).toBeNull();
      expect(similarCalls).toHaveLength(0);
    });

    it('libère le verrou en fin de run', async () => {
      await service.runOnce();
      expect(lock.current).toBeNull();
    });

    it('libère le verrou même si le run échoue', async () => {
      queue = [target('1')];
      similarErrors['complete:1'] = new Error('boom');
      (
        service as unknown as { priority: { buildQueue: jest.Mock } }
      ).priority.buildQueue = jest.fn(() => Promise.reject(new Error('db')));
      await expect(service.runOnce()).rejects.toThrow('db');
      expect(lock.current).toBeNull();
    });
  });

  describe('fail-closed sans sel', () => {
    it('ne fait AUCUN appel réseau si la pseudonymisation est impossible', async () => {
      (
        service as unknown as { hasher: { isConfigured: boolean } }
      ).hasher.isConfigured = false;
      queue = [target('1')];
      expect(await service.runOnce()).toBeNull();
      expect(similarCalls).toHaveLength(0);
      expect(lock.current).toBeNull();
    });
  });

  describe('découverte', () => {
    it('sonde les cinq types de liste par série', async () => {
      queue = [target('42')];
      await service.runOnce();
      expect(similarCalls).toEqual(
        READER_LIST_TYPES.map((type) => `${type}:42`),
      );
    });

    it('persiste le signal de la découverte, déjà pseudonymisé', async () => {
      queue = [target('42')];
      similarByKey['complete:42'] = [
        { userId: '75503901', rating: 8.5 },
        { userId: '114128543', rating: null },
      ];
      await service.runOnce();

      const discovery = writtenRows.filter((r) => r.muId === '42');
      expect(discovery).toEqual(
        expect.arrayContaining([
          {
            userHash: 'hash-75503901',
            muId: '42',
            listType: 'complete',
            rating: 8.5,
          },
        ]),
      );
      // Aucun identifiant MU brut ne part en écriture.
      expect(JSON.stringify(writtenRows)).not.toContain('"75503901"');
    });

    it('traite sans broncher une série sans aucun lecteur', async () => {
      queue = [target('42')];
      const outcome = await service.runOnce();
      expect(outcome?.discoveryProbes).toBe(READER_LIST_TYPES.length);
      expect(outcome?.readersDiscovered).toBe(0);
      expect(outcome?.rowsWritten).toBe(0);
      expect(listsCalls).toHaveLength(0);
    });

    it('avance le curseur du nombre de séries réellement sondées', async () => {
      queue = [target('1'), target('2')];
      await service.runOnce();
      expect(cursorsAdvanced).toEqual([{ bucket: 'Manhwa', consumed: 2 }]);
    });
  });

  describe('extraction', () => {
    beforeEach(() => {
      queue = [target('42')];
      similarByKey['complete:42'] = [{ userId: '900', rating: 9 }];
      listsByUser['900'] = [
        { listId: '2', listType: 'complete' },
        { listId: '0', listType: 'read' },
      ];
      listPages['900/2'] = { rows: ['1000', '1001'], totalHits: 2 };
      listPages['900/0'] = { rows: ['1002'], totalHits: 1 };
    });

    it('lit les listes publiques puis leur contenu', async () => {
      const outcome = await service.runOnce();
      expect(listsCalls).toEqual(['900']);
      expect(pageCalls).toEqual(['900/2/1', '900/0/1']);
      expect(outcome?.readersExtracted).toBe(1);
      expect(writtenRows.map((r) => r.muId)).toEqual(
        expect.arrayContaining(['1000', '1001', '1002']),
      );
    });

    it('n’émet qu’une requête par liste tant que perpage suffit', async () => {
      listPages['900/2'] = { rows: ['1000'], totalHits: 900 };
      await service.runOnce();
      expect(pageCalls.filter((c) => c.startsWith('900/2'))).toEqual([
        '900/2/1',
      ]);
    });

    it('pagine une liste plus grande que perpage, sans dépasser le plafond', async () => {
      build({ READER_SIGNAL_PER_PAGE: '2', READER_SIGNAL_MAX_LIST_PAGES: '3' });
      similarByKey['complete:42'] = [{ userId: '900', rating: 9 }];
      listsByUser['900'] = [{ listId: '2', listType: 'complete' }];
      // 20 titres à 2 par page : le plafond de 3 pages doit trancher.
      listPages['900/2'] = { rows: ['1000', '1001'], totalHits: 20 };
      await service.runOnce();
      expect(pageCalls.filter((c) => c.startsWith('900/2'))).toEqual([
        '900/2/1',
        '900/2/2',
        '900/2/3',
      ]);
    });

    it('marque « empty » un lecteur sans liste publique, sans échec', async () => {
      listsByUser['900'] = [];
      const outcome = await service.runOnce();
      expect(profiles).toEqual([{ hash: 'hash-900', status: 'empty' }]);
      expect(outcome?.readersEmpty).toBe(1);
      expect(outcome?.readersFailed).toBe(0);
    });
  });

  describe('fenêtre de rafraîchissement', () => {
    beforeEach(() => {
      queue = [target('42')];
      similarByKey['complete:42'] = [
        { userId: '900', rating: null },
        { userId: '901', rating: null },
      ];
      listsByUser['901'] = [{ listId: '2', listType: 'complete' }];
      listPages['901/2'] = { rows: ['1000'], totalHits: 1 };
    });

    it('ne re-collecte PAS un lecteur vu récemment', async () => {
      freshHashes = new Set(['hash-900']);
      const outcome = await service.runOnce();
      expect(listsCalls).toEqual(['901']);
      expect(outcome?.readersSkippedFresh).toBe(1);
      expect(outcome?.readersExtracted).toBe(1);
    });

    it('conserve tout de même le signal de découverte du lecteur ignoré', async () => {
      freshHashes = new Set(['hash-900', 'hash-901']);
      await service.runOnce();
      // La découverte est déjà payée : ses lignes sont écrites même si
      // l'extraction du lecteur est sautée.
      expect(writtenRows.some((r) => r.userHash === 'hash-900')).toBe(true);
      expect(listsCalls).toHaveLength(0);
    });

    it('interroge la base avec la fenêtre configurée', async () => {
      build({ READER_SIGNAL_READER_TTL_DAYS: '7' });
      similarByKey['complete:42'] = [{ userId: '900', rating: null }];
      await service.runOnce();
      const spy = (
        service as unknown as { writer: { findFreshReaders: jest.Mock } }
      ).writer;
      expect(spy.findFreshReaders).toHaveBeenCalledWith(
        ['hash-900'],
        7,
        expect.any(Number),
      );
    });
  });

  describe('budget', () => {
    it('ne dépasse JAMAIS le budget configuré', async () => {
      build({ READER_SIGNAL_BUDGET_PER_RUN: '7' });
      queue = Array.from({ length: 50 }, (_, i) => target(String(i)));
      const outcome = await service.runOnce();
      expect(outcome?.requestsUsed).toBeLessThanOrEqual(7);
      expect(similarCalls.length + listsCalls.length + pageCalls.length).toBe(
        outcome?.requestsUsed,
      );
    });

    it('réserve une part du budget à la découverte', async () => {
      // 20 requêtes, part de découverte 0,5 → 10 requêtes = 2 séries × 5
      // types ; le reste va à l'extraction.
      build({
        READER_SIGNAL_BUDGET_PER_RUN: '20',
        READER_SIGNAL_DISCOVERY_SHARE: '0.5',
      });
      queue = Array.from({ length: 10 }, (_, i) => target(String(i)));
      similarByKey['complete:0'] = [{ userId: '900', rating: null }];
      listsByUser['900'] = [{ listId: '2', listType: 'complete' }];
      listPages['900/2'] = { rows: ['1000'], totalHits: 1 };

      const outcome = await service.runOnce();
      expect(outcome?.discoveryProbes).toBe(10);
      expect(listsCalls).toEqual(['900']);
    });

    it('respecte la cadence MU entre deux requêtes', async () => {
      queue = [target('1')];
      await service.runOnce();
      // Une pause de 2 s avant chaque requête sauf la première.
      expect(sleeps).toEqual([2000, 2000, 2000, 2000]);
    });
  });

  describe('disjoncteur', () => {
    it('arrête le run après N échecs CONSÉCUTIFS', async () => {
      build({ READER_SIGNAL_MAX_FAILURES: '2' });
      queue = [target('1'), target('2')];
      for (const type of READER_LIST_TYPES) {
        similarErrors[`${type}:1`] = new Error('MU down');
        similarErrors[`${type}:2`] = new Error('MU down');
      }
      const outcome = await service.runOnce();
      expect(outcome?.circuitBroken).toBe(true);
      expect(similarCalls).toHaveLength(2);
    });

    it('remet le compteur à zéro sur un succès', async () => {
      build({ READER_SIGNAL_MAX_FAILURES: '2' });
      queue = [target('1')];
      similarErrors['complete:1'] = new Error('MU hoquet');
      // `read` réussit → le compteur repart à 0, le run continue.
      const outcome = await service.runOnce();
      expect(outcome?.circuitBroken).toBe(false);
      expect(similarCalls).toHaveLength(READER_LIST_TYPES.length);
    });
  });

  describe('observabilité', () => {
    it('ventile les lignes écrites par type d’œuvre', async () => {
      queue = [target('42')];
      similarByKey['complete:42'] = [{ userId: '900', rating: 8 }];
      listsByUser['900'] = [{ listId: '2', listType: 'complete' }];
      listPages['900/2'] = { rows: ['1000'], totalHits: 1 };
      const outcome = await service.runOnce();
      expect(outcome?.rowsByMangaType).toEqual({ Manhwa: 2 });
      expect(outcome?.rowsWithRating).toBe(1);
      expect(outcome?.probesByBucket).toEqual({ Manhwa: 5 });
    });
  });
});
