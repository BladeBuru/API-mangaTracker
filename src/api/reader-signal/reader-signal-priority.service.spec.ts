import { NSFW_GENRES } from '@/api/mangas/constants';
import {
  DISCOVERY_TYPES,
  DiscoveryTarget,
  interleave,
  LIBRARY_BUCKET,
  ReaderSignalPriorityService,
} from './reader-signal-priority.service';

/** Fabrique de cibles, pour alléger les cas de test. */
function target(muId: string, bucket: string): DiscoveryTarget {
  return { muId, mangaType: bucket === LIBRARY_BUCKET ? null : bucket, bucket };
}

describe('ReaderSignalPriorityService', () => {
  let service: ReaderSignalPriorityService;
  let queries: Array<{ sql: string; params: unknown[] }>;
  let rowsByType: Record<string, Array<{ mu_id: string; type: string }>>;
  let libraryRows: Array<{ mu_id: string; type: string | null }>;
  let states: Record<string, { job_name: string; last_completed_page: number }>;
  let saved: Array<Record<string, unknown>>;

  beforeEach(() => {
    queries = [];
    libraryRows = [];
    rowsByType = { Manga: [], Manhwa: [], Manhua: [] };
    states = {};
    saved = [];

    const mangaRepo = {
      query: jest.fn((sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('FROM user_manga um')) {
          const [offset, limit] = params as [number, number];
          return Promise.resolve(libraryRows.slice(offset, offset + limit));
        }
        const [type, offset, limit] = params as [string, number, number];
        return Promise.resolve(
          (rowsByType[type] ?? []).slice(offset, offset + limit),
        );
      }),
    };
    const stateRepo = {
      findOneBy: jest.fn(({ job_name }: { job_name: string }) =>
        Promise.resolve(states[job_name] ?? null),
      ),
      create: jest.fn((data: Record<string, unknown>) => ({ ...data })),
      save: jest.fn((entity: Record<string, unknown>) => {
        saved.push(entity);
        return Promise.resolve(entity);
      }),
    };
    service = new ReaderSignalPriorityService(
      mangaRepo as never,
      stateRepo as never,
    );
  });

  /** Remplit un seau de type avec `count` séries fictives. */
  function fillType(type: string, count: number): void {
    rowsByType[type] = Array.from({ length: count }, (_, i) => ({
      mu_id: `${type}-${i}`,
      type,
    }));
  }

  describe('équilibre par type', () => {
    it('sert les trois types à part égale, manhwa et manhua d’abord', async () => {
      for (const type of DISCOVERY_TYPES) fillType(type, 50);
      const { targets } = await service.buildQueue(12, 1500, NSFW_GENRES);

      expect(targets).toHaveLength(12);
      const counts = targets.reduce<Record<string, number>>((acc, t) => {
        acc[t.bucket] = (acc[t.bucket] ?? 0) + 1;
        return acc;
      }, {});
      expect(counts).toEqual({ Manhwa: 4, Manhua: 4, Manga: 4 });
      // Le round-robin place le manhwa en tête : si le budget est coupé,
      // c'est le point faible du produit qui est servi en premier.
      expect(targets[0].bucket).toBe('Manhwa');
      expect(targets[1].bucket).toBe('Manhua');
      expect(targets[2].bucket).toBe('Manga');
    });

    it('ne laisse pas le manga japonais dominer quand le budget est coupé', async () => {
      // Le catalogue est massivement japonais : sans round-robin, un simple
      // ORDER BY rating produirait 5 manga sur 5.
      for (const type of DISCOVERY_TYPES) fillType(type, 500);
      const { targets } = await service.buildQueue(5, 1500, NSFW_GENRES);
      const mangaCount = targets.filter((t) => t.bucket === 'Manga').length;
      expect(mangaCount).toBeLessThanOrEqual(2);
    });

    it('redistribue le budget quand un type est épuisé', async () => {
      fillType('Manhwa', 1);
      fillType('Manhua', 10);
      fillType('Manga', 10);
      const { targets } = await service.buildQueue(9, 1500, NSFW_GENRES);
      expect(targets).toHaveLength(9);
      expect(targets.filter((t) => t.bucket === 'Manhwa')).toHaveLength(1);
    });
  });

  describe('priorité aux bibliothèques utilisateurs', () => {
    it('sert la bibliothèque avant les seaux de type', async () => {
      libraryRows = [
        { mu_id: 'lib-1', type: 'Manhwa' },
        { mu_id: 'lib-2', type: null },
      ];
      for (const type of DISCOVERY_TYPES) fillType(type, 50);
      const { targets } = await service.buildQueue(6, 1500, NSFW_GENRES);
      expect(targets[0].bucket).toBe(LIBRARY_BUCKET);
      expect(targets.filter((t) => t.bucket === LIBRARY_BUCKET)).toHaveLength(
        2,
      );
    });

    it('n’interroge pas les seaux de type si la bibliothèque suffit', async () => {
      libraryRows = Array.from({ length: 10 }, (_, i) => ({
        mu_id: `lib-${i}`,
        type: 'Manhwa',
      }));
      const { targets, cursors } = await service.buildQueue(
        5,
        1500,
        NSFW_GENRES,
      );
      expect(targets).toHaveLength(5);
      expect(cursors).toHaveLength(1);
      expect(cursors[0].bucket).toBe(LIBRARY_BUCKET);
    });
  });

  describe('curseurs', () => {
    it('repart de l’offset persisté', async () => {
      states[ReaderSignalPriorityService.stateName('Manhwa')] = {
        job_name: 'x',
        last_completed_page: 40,
      };
      fillType('Manhwa', 100);
      const { targets } = await service.buildQueue(3, 1500, NSFW_GENRES);
      const manhwa = targets.find((t) => t.bucket === 'Manhwa');
      expect(manhwa?.muId).toBe('Manhwa-40');
    });

    it('avance le curseur d’autant de séries consommées', async () => {
      await service.advanceCursor(
        { bucket: 'Manga', offset: 100, depth: 1500, exhausted: false },
        25,
      );
      expect(saved[0].last_completed_page).toBe(125);
      expect(saved[0].last_run_status).toBe('partial');
    });

    it('remet le curseur à 0 quand le seau est épuisé', async () => {
      // Cas de la bibliothèque : 87 titres pour une profondeur bien plus
      // grande. Sans remise à zéro, le seau se figerait au-delà de son
      // contenu et ne rendrait plus jamais rien.
      await service.advanceCursor(
        { bucket: LIBRARY_BUCKET, offset: 80, depth: 1000, exhausted: true },
        7,
      );
      expect(saved[0].last_completed_page).toBe(0);
      expect(saved[0].last_run_status).toBe('completed');
      expect(saved[0].completed_at).toBeInstanceOf(Date);
    });

    it('remet le curseur à 0 quand la profondeur est atteinte', async () => {
      await service.advanceCursor(
        { bucket: 'Manhua', offset: 1490, depth: 1500, exhausted: false },
        10,
      );
      expect(saved[0].last_completed_page).toBe(0);
    });

    it('ne touche à rien si rien n’a été consommé', async () => {
      await service.advanceCursor(
        { bucket: 'Manga', offset: 0, depth: 1500, exhausted: false },
        0,
      );
      expect(saved).toHaveLength(0);
    });

    it('nomme les lignes d’état sous un préfixe dédié', () => {
      expect(ReaderSignalPriorityService.stateName('Manhwa')).toBe(
        'reader-signal:disc:Manhwa',
      );
    });
  });

  describe('exclusion NSFW', () => {
    it('passe la liste des genres exclus à la requête de ciblage', async () => {
      fillType('Manhwa', 5);
      await service.buildQueue(3, 1500, NSFW_GENRES);
      const typeQuery = queries.find((q) => q.sql.includes('FROM manga m'));
      expect(typeQuery?.sql).toContain('json_array_elements_text');
      expect(typeQuery?.params[3]).toEqual([...NSFW_GENRES]);
    });
  });

  describe('interleave', () => {
    it('préserve l’ordre interne de chaque seau', () => {
      const out = interleave(
        [
          [target('a1', 'A'), target('a2', 'A')],
          [target('b1', 'B'), target('b2', 'B')],
        ],
        4,
      );
      expect(out.map((t) => t.muId)).toEqual(['a1', 'b1', 'a2', 'b2']);
    });

    it('s’arrête à la limite demandée', () => {
      const out = interleave(
        [[target('a1', 'A'), target('a2', 'A')], [target('b1', 'B')]],
        2,
      );
      expect(out).toHaveLength(2);
    });

    it('gère des seaux vides sans boucler', () => {
      expect(interleave([[], []], 10)).toEqual([]);
      expect(interleave([], 10)).toEqual([]);
    });
  });

  it('ne renvoie rien pour un budget nul ou négatif', async () => {
    expect(await service.buildQueue(0, 1500, NSFW_GENRES)).toEqual({
      targets: [],
      cursors: [],
    });
  });
});
