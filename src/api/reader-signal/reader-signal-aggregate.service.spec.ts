import { ConfigService } from '@nestjs/config';
import { NSFW_GENRES } from '@/api/mangas/constants';
import { ReaderSignalAggregateService } from './reader-signal-aggregate.service';
import { DISCOVERY_TYPES } from './reader-signal-priority.service';
import {
  cosineScore,
  LIST_TYPE_AFFINITY,
  pairContribution,
  signalAffinity,
} from './reader-signal-weights';

function config(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    READER_SIGNAL_ENABLED: 'true',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('ReaderSignalAggregateService', () => {
  let service: ReaderSignalAggregateService;
  let queries: Array<{ sql: string; params?: unknown[] }>;
  let stats: { pairs: string; series: string; negative: string };

  function build(overrides: Record<string, string> = {}): void {
    queries = [];
    stats = { pairs: '0', series: '0', negative: '0' };
    const manager = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('FROM bounded')) {
          return Promise.resolve([{ count: '12' }]);
        }
        return Promise.resolve([]);
      }),
    };
    const dataSource = {
      transaction: jest.fn((cb: (m: typeof manager) => Promise<void>) =>
        cb(manager),
      ),
    };
    const cooccurrenceRepo = {
      query: jest.fn(() => Promise.resolve([stats])),
    };
    service = new ReaderSignalAggregateService(
      dataSource as never,
      cooccurrenceRepo as never,
      config(overrides),
    );
  }

  beforeEach(() => build());

  /** SQL du INSERT (celui qui contient les CTE ET l'écriture). */
  function insertSql(): string {
    return queries.find((q) => /INSERT INTO reader_cooccurrence/i.test(q.sql))
      ?.sql as string;
  }

  describe('aucun appel réseau', () => {
    it('ne dépend d’aucun client HTTP', () => {
      // Le constructeur ne prend que la source de données, le dépôt et la
      // config : impossible d'appeler MangaUpdates depuis ce service.
      expect(ReaderSignalAggregateService.length).toBe(3);
    });
  });

  describe('recompute', () => {
    it('vide puis reconstruit dans UNE seule transaction', async () => {
      await service.recompute();
      const sqls = queries.map((q) => q.sql);
      const truncateIndex = sqls.findIndex((s) => /TRUNCATE/i.test(s));
      const insertIndex = sqls.findIndex((s) =>
        /INSERT INTO reader_cooccurrence/i.test(s),
      );
      expect(truncateIndex).toBeGreaterThanOrEqual(0);
      expect(insertIndex).toBeGreaterThan(truncateIndex);
      const dataSource = (
        service as unknown as { dataSource: { transaction: jest.Mock } }
      ).dataSource;
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('est idempotent : deux passes émettent exactement le même SQL', async () => {
      await service.recompute();
      const first = queries.map((q) => q.sql);
      queries = [];
      await service.recompute();
      expect(queries.map((q) => q.sql)).toEqual(first);
    });

    it('écrit les DEUX sens de chaque paire', async () => {
      await service.recompute();
      const sql = insertSql();
      expect(sql).toContain('SELECT mu_a, mu_b, co_readers, weight, score');
      expect(sql).toContain('UNION ALL');
      expect(sql).toContain('SELECT mu_b, mu_a, co_readers, weight, score');
    });

    it('applique la pondération générée depuis les constantes partagées', async () => {
      await service.recompute();
      const sql = insertSql();
      expect(sql).toContain(`WHEN 'complete' THEN`);
      expect(sql).toContain(String(LIST_TYPE_AFFINITY.unfinished));
      expect(sql).toContain('rs.rating');
    });

    it('neutralise la contribution des paires deux fois négatives', async () => {
      await service.recompute();
      expect(insertSql()).toContain(
        'CASE WHEN a.w <= 0 AND b.w <= 0 THEN 0 ELSE a.w * b.w END',
      );
    });

    it('ne garde qu’une affinité par (lecteur, œuvre), la plus tranchée', async () => {
      await service.recompute();
      const sql = insertSql();
      expect(sql).toContain('DISTINCT ON (user_hash, mu_id)');
      expect(sql).toContain('ORDER BY user_hash, mu_id, ABS(w) DESC');
    });

    it('normalise le score en cosinus', async () => {
      await service.recompute();
      const sql = insertSql();
      expect(sql).toContain('SQRT(SUM(w * w))');
      expect(sql).toContain('p.weight / (na.n * nb.n)');
    });

    it('restreint le calcul au focus set (bibliothèques + tête par type)', async () => {
      await service.recompute();
      const sql = insertSql();
      expect(sql).toContain('FROM user_manga um');
      expect(sql).toContain('PARTITION BY m.type');
      expect(sql).toContain('json_array_elements_text');
    });

    it('passe les bons paramètres (NSFW, profondeur, types, bornes)', async () => {
      build({
        READER_SIGNAL_TYPE_DEPTH: '900',
        READER_SIGNAL_MAX_VECTOR_SIZE: '500',
        READER_SIGNAL_MIN_CO_READERS: '4',
      });
      await service.recompute();
      const insert = queries.find((q) =>
        /INSERT INTO reader_cooccurrence/i.test(q.sql),
      );
      expect(insert?.params).toEqual([
        [...NSFW_GENRES],
        900,
        [...DISCOVERY_TYPES],
        500,
        4,
      ]);
    });

    it('exclut les lecteurs hors bornes de taille de vecteur', async () => {
      await service.recompute();
      const sql = insertSql();
      expect(sql).toContain('HAVING COUNT(*) >= 2 AND COUNT(*) <= $4');
    });

    it('exige un minimum de lecteurs communs par paire', async () => {
      await service.recompute();
      expect(insertSql()).toContain('HAVING COUNT(*) >= $5');
    });

    it('remonte le bilan du run', async () => {
      stats = { pairs: '1200', series: '80', negative: '35' };
      const outcome = await service.recompute();
      expect(outcome.pairsWritten).toBe(1200);
      expect(outcome.seriesCovered).toBe(80);
      expect(outcome.negativePairs).toBe(35);
      expect(outcome.readersUsed).toBe(12);
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('purgeRawSignal', () => {
    it('est désactivée par défaut — aucune suppression', async () => {
      expect(await service.purgeRawSignal()).toBe(0);
      expect(queries).toHaveLength(0);
    });

    it('supprime les lignes brutes et les profils devenus orphelins', async () => {
      build({ READER_SIGNAL_RAW_TTL_DAYS: '90' });
      await service.purgeRawSignal();
      const sqls = queries.map((q) => q.sql);
      expect(sqls[0]).toContain('DELETE FROM reader_signal');
      expect(sqls[1]).toContain('DELETE FROM reader_profile');
      // Un profil dont il reste du signal n'est jamais supprimé.
      expect(sqls[1]).toContain('NOT EXISTS');
      const cutoff = queries[0].params?.[0] as Date;
      const expected = Date.now() - 90 * 86_400_000;
      expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(5_000);
    });
  });

  /**
   * Le SQL n'est pas exécuté ici (pas de PostgreSQL en test unitaire) : ces
   * cas vérifient la SÉMANTIQUE de la pondération sur les mêmes fonctions
   * TypeScript que le SQL reprojette, en reproduisant à la main ce que la
   * requête calcule. C'est ce qui donne un sens aux assertions de chaîne
   * ci-dessus.
   */
  describe('sémantique de l’agrégat (référence TypeScript)', () => {
    /** Reproduit le calcul d'une paire sur un jeu de lecteurs. */
    function aggregate(readers: Array<[number, number]>): {
      weight: number;
      score: number;
    } {
      const weight = readers.reduce(
        (sum, [wa, wb]) => sum + pairContribution(wa, wb),
        0,
      );
      const normA = Math.sqrt(readers.reduce((sum, [wa]) => sum + wa * wa, 0));
      const normB = Math.sqrt(
        readers.reduce((sum, [, wb]) => sum + wb * wb, 0),
      );
      return { weight, score: cosineScore(weight, normA, normB) };
    }

    it('rapproche deux titres terminés par les mêmes lecteurs', () => {
      const w = signalAffinity('complete', null);
      const { score } = aggregate([
        [w, w],
        [w, w],
        [w, w],
      ]);
      expect(score).toBeCloseTo(1);
    });

    it('ÉLOIGNE un titre aimé d’un titre abandonné par les mêmes lecteurs', () => {
      const liked = signalAffinity('complete', null);
      const dropped = signalAffinity('unfinished', null);
      const { score } = aggregate([
        [liked, dropped],
        [liked, dropped],
      ]);
      expect(score).toBeLessThan(0);
    });

    it('ne fabrique aucune similarité entre deux titres abandonnés', () => {
      const dropped = signalAffinity('unfinished', null);
      const { weight, score } = aggregate([
        [dropped, dropped],
        [dropped, dropped],
      ]);
      expect(weight).toBe(0);
      expect(score).toBe(0);
    });

    it('affaiblit une paire portée par de simples intentions', () => {
      const wished = signalAffinity('wish', null);
      const completed = signalAffinity('complete', null);
      const intent = aggregate([
        [wished, wished],
        [wished, wished],
      ]);
      const real = aggregate([
        [completed, completed],
        [completed, completed],
      ]);
      expect(intent.weight).toBeLessThan(real.weight);
    });

    it('retourne le signe quand un « terminé » est mal noté', () => {
      const liked = signalAffinity('complete', 9);
      const hated = signalAffinity('complete', 2);
      expect(aggregate([[liked, hated]]).score).toBeLessThan(0);
    });
  });
});
