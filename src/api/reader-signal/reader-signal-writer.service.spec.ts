import {
  PersistableSignalRow,
  ReaderSignalWriterService,
} from './reader-signal-writer.service';

/** Une requête SQL capturée, telle qu'elle partirait vers PostgreSQL. */
interface CapturedQuery {
  sql: string;
  params: unknown[];
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function row(
  overrides: Partial<PersistableSignalRow> = {},
): PersistableSignalRow {
  return {
    userHash: HASH_A,
    muId: '15180124327',
    listType: 'complete',
    rating: 8.5,
    ...overrides,
  };
}

describe('ReaderSignalWriterService', () => {
  let service: ReaderSignalWriterService;
  let signalQueries: CapturedQuery[];
  let profileQueries: CapturedQuery[];
  let mangaRows: Array<{ mu_id: string; type: string | null }>;

  beforeEach(() => {
    signalQueries = [];
    profileQueries = [];
    mangaRows = [];
    const signalRepo = {
      query: jest.fn((sql: string, params: unknown[]) => {
        signalQueries.push({ sql, params });
        return Promise.resolve([]);
      }),
    };
    const profileRepo = {
      query: jest.fn((sql: string, params: unknown[]) => {
        profileQueries.push({ sql, params });
        return Promise.resolve([]);
      }),
    };
    const mangaRepo = { find: jest.fn(() => Promise.resolve(mangaRows)) };
    service = new ReaderSignalWriterService(
      signalRepo as never,
      profileRepo as never,
      mangaRepo as never,
    );
  });

  /** Toutes les valeurs envoyées à PostgreSQL, aplaties. */
  function allWrittenValues(): string {
    return JSON.stringify([
      ...signalQueries.map((q) => [q.sql, q.params]),
      ...profileQueries.map((q) => [q.sql, q.params]),
    ]);
  }

  describe('RGPD — aucun champ identifiant persisté', () => {
    it('n’écrit que hash, mu_id, type de liste, note et horodatage', async () => {
      const known = new Map([['15180124327', 'Manhwa']]);
      await service.writeSignal([row()], known);

      const insert = signalQueries[0];
      const columns = /\(([^)]*)\)\s*\n?\s*VALUES/i.exec(insert.sql)?.[1] ?? '';
      expect(
        columns
          .split(',')
          .map((c) => c.trim())
          .sort(),
      ).toEqual(['collected_at', 'list_type', 'mu_id', 'rating', 'user_hash']);
    });

    it('ne laisse fuir ni pseudo, ni URL, ni identifiant MU brut', async () => {
      // Un appelant tenterait-il de passer autre chose, la signature ne
      // l'accepte pas — ce test verrouille ce qui part RÉELLEMENT en base.
      const known = new Map([['15180124327', 'Manhwa']]);
      await service.writeSignal([row()], known);
      await service.recordProfile(HASH_A, 'collected', 4, 120);

      const written = allWrittenValues();
      expect(written).not.toMatch(/user_name/i);
      expect(written).not.toMatch(/mangaupdates\.com/i);
      // Le seul identifiant présent est le hash, jamais un `user_id` MU.
      expect(written).toContain(HASH_A);
      expect(written).not.toMatch(/\b75503901\b/);
    });

    it('n’expose aucun identifiant dans les paramètres du profil', async () => {
      await service.recordProfile(HASH_B, 'empty', 0, 0);
      expect(profileQueries[0].params[0]).toBe(HASH_B);
      expect(profileQueries[0].params).toHaveLength(5);
    });
  });

  describe('writeSignal', () => {
    it('est idempotent — ON CONFLICT DO UPDATE sur la clé métier', async () => {
      const known = new Map([['15180124327', 'Manhwa']]);
      await service.writeSignal([row()], known);
      const sql = signalQueries[0].sql;
      expect(sql).toContain('ON CONFLICT (user_hash, mu_id, list_type)');
      expect(sql).toContain('DO UPDATE SET');
    });

    it('ne remplace JAMAIS une note connue par un null', async () => {
      // Un lecteur qui masque ses notes après coup ne doit pas effacer un
      // signal déjà collecté légitimement.
      const known = new Map([['15180124327', 'Manhwa']]);
      await service.writeSignal([row({ rating: null })], known);
      expect(signalQueries[0].sql).toContain(
        'rating = COALESCE(EXCLUDED.rating, reader_signal.rating)',
      );
    });

    it('ignore les séries absentes du catalogue, sans les créer', async () => {
      const known = new Map([['15180124327', 'Manhwa']]);
      const outcome = await service.writeSignal(
        [row(), row({ muId: '999999999' })],
        known,
      );
      expect(outcome.written).toBe(1);
      expect(outcome.unknownSeries).toBe(1);
      expect(JSON.stringify(signalQueries)).not.toContain('999999999');
      // Aucune requête d'insertion dans `manga` n'est émise.
      expect(JSON.stringify(signalQueries)).not.toMatch(/INSERT INTO manga/i);
    });

    it('n’émet aucune requête quand tout est hors catalogue', async () => {
      const outcome = await service.writeSignal([row()], new Map());
      expect(signalQueries).toHaveLength(0);
      expect(outcome.written).toBe(0);
      expect(outcome.unknownSeries).toBe(1);
    });

    it('ventile les lignes par type d’œuvre, « inconnu » pour un type NULL', async () => {
      const known = new Map<string, string | null>([
        ['1', 'Manhwa'],
        ['2', 'Manhua'],
        ['3', null],
      ]);
      const outcome = await service.writeSignal(
        [
          row({ muId: '1' }),
          row({ muId: '2', rating: null }),
          row({ muId: '3' }),
        ],
        known,
      );
      expect(outcome.byMangaType).toEqual({
        Manhwa: 1,
        Manhua: 1,
        inconnu: 1,
      });
      expect(outcome.written).toBe(3);
      expect(outcome.withRating).toBe(2);
    });

    it('découpe les gros lots en plusieurs requêtes', async () => {
      const known = new Map<string, string | null>();
      const rows: PersistableSignalRow[] = [];
      for (let i = 0; i < 1200; i++) {
        known.set(String(i), 'Manga');
        rows.push(row({ muId: String(i) }));
      }
      await service.writeSignal(rows, known);
      expect(signalQueries.length).toBe(3);
    });
  });

  describe('knownSeries', () => {
    it('renvoie une map mu_id → type et dédoublonne l’entrée', async () => {
      mangaRows = [
        { mu_id: '1', type: 'Manhwa' },
        { mu_id: '2', type: null },
      ];
      const known = await service.knownSeries(['1', '2', '1']);
      expect(known.get('1')).toBe('Manhwa');
      expect(known.get('2')).toBeNull();
      expect(known.size).toBe(2);
    });

    it('n’interroge pas la base pour un lot vide', async () => {
      const known = await service.knownSeries([]);
      expect(known.size).toBe(0);
    });
  });

  describe('findFreshReaders — fenêtre de rafraîchissement', () => {
    it('interroge la base avec le seuil de fraîcheur et le plafond d’échecs', async () => {
      (
        service as unknown as { profileRepository: { query: jest.Mock } }
      ).profileRepository.query = jest.fn((sql: string, params: unknown[]) => {
        profileQueries.push({ sql, params });
        return Promise.resolve([{ user_hash: HASH_A }]);
      });
      const before = Date.now();
      const fresh = await service.findFreshReaders([HASH_A, HASH_B], 30, 3);

      expect(fresh.has(HASH_A)).toBe(true);
      expect(fresh.has(HASH_B)).toBe(false);
      const [hashes, threshold, maxFailures] = profileQueries[0].params as [
        string[],
        Date,
        number,
      ];
      expect(hashes).toEqual([HASH_A, HASH_B]);
      expect(maxFailures).toBe(3);
      // 30 jours en arrière, à quelques millisecondes près.
      const expected = before - 30 * 86_400_000;
      expect(Math.abs(threshold.getTime() - expected)).toBeLessThan(5_000);
    });

    it('ne fait aucune requête sans lecteur à vérifier', async () => {
      const fresh = await service.findFreshReaders([], 30, 3);
      expect(fresh.size).toBe(0);
      expect(profileQueries).toHaveLength(0);
    });
  });

  describe('recordProfile', () => {
    it('incrémente les échecs consécutifs et les remet à 0 sinon', async () => {
      await service.recordProfile(HASH_A, 'failed', 0, 0);
      const sql = profileQueries[0].sql;
      expect(sql).toContain('ON CONFLICT (user_hash) DO UPDATE');
      expect(sql).toContain('reader_profile.failure_count + 1');
      expect(sql).toContain('ELSE 0 END');
    });

    it('traite « aucune liste publique » comme un succès, pas un échec', async () => {
      await service.recordProfile(HASH_A, 'empty', 0, 0);
      expect(profileQueries[0].params[4]).toBe(0);
    });
  });
});
