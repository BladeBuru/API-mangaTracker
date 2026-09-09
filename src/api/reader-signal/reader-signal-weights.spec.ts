import {
  affinitySqlExpression,
  cosineScore,
  isReaderListType,
  LIST_TYPE_AFFINITY,
  pairContribution,
  pairContributionSql,
  ratingAffinity,
  READER_LIST_TYPES,
  signalAffinity,
} from './reader-signal-weights';

/**
 * La pondération est le seul endroit où le produit décide « ce que vaut »
 * un signal. Une erreur de signe y est invisible en production (les
 * recommandations restent plausibles) mais recommande exactement ce que le
 * lecteur a abandonné. D'où des tests explicites sur chaque cas de bord.
 */
describe('pondération du signal de lecture', () => {
  describe('affinité par type de liste', () => {
    it('classe les cinq types dans l’ordre voulu', () => {
      const { complete, read, wish, hold, unfinished } = LIST_TYPE_AFFINITY;
      expect(complete).toBeGreaterThan(read);
      expect(read).toBeGreaterThan(wish);
      expect(wish).toBeGreaterThan(0);
      expect(hold).toBeLessThan(0);
      expect(unfinished).toBeLessThan(hold);
    });

    it('garde toutes les affinités dans [-1, 1]', () => {
      for (const type of READER_LIST_TYPES) {
        expect(LIST_TYPE_AFFINITY[type]).toBeGreaterThanOrEqual(-1);
        expect(LIST_TYPE_AFFINITY[type]).toBeLessThanOrEqual(1);
      }
    });

    it('retombe sur le type quand la note est absente', () => {
      expect(signalAffinity('complete', null)).toBe(1);
      expect(signalAffinity('read', undefined)).toBe(0.6);
      expect(signalAffinity('unfinished', null)).toBe(-0.5);
    });
  });

  describe('affinité par note', () => {
    it('mappe l’échelle MU sur [-1, 1] autour de 5,5', () => {
      expect(ratingAffinity(10)).toBeCloseTo(1);
      expect(ratingAffinity(5.5)).toBeCloseTo(0);
      expect(ratingAffinity(1)).toBeCloseTo(-1);
      expect(ratingAffinity(8)).toBeGreaterThan(0);
      expect(ratingAffinity(4)).toBeLessThan(0);
    });

    it('borne une note aberrante au lieu de sortir de l’intervalle', () => {
      expect(ratingAffinity(-5)).toBe(-1);
      expect(ratingAffinity(99)).toBe(1);
    });
  });

  describe('signalAffinity — règle du minimum', () => {
    it('rend NÉGATIF un « terminé » mal noté', () => {
      // Le cas qui justifie la règle : aller au bout d'un titre et le noter
      // 2/10 est un rejet, pas une recommandation.
      expect(signalAffinity('complete', 2)).toBeLessThan(0);
    });

    it('ne rend JAMAIS positif un abandon, même très bien noté', () => {
      expect(signalAffinity('unfinished', 10)).toBe(
        LIST_TYPE_AFFINITY.unfinished,
      );
      expect(signalAffinity('hold', 9.5)).toBe(LIST_TYPE_AFFINITY.hold);
    });

    it('plafonne une intention au poids de son type', () => {
      // Une wish-list notée 10 reste une intention : le lecteur n'a rien lu.
      expect(signalAffinity('wish', 10)).toBe(LIST_TYPE_AFFINITY.wish);
    });

    it('rend un abandon mal noté ENCORE plus négatif', () => {
      expect(signalAffinity('unfinished', 1)).toBeLessThan(
        LIST_TYPE_AFFINITY.unfinished,
      );
    });

    it('est monotone croissante en la note, à type constant', () => {
      for (const type of READER_LIST_TYPES) {
        const values = [1, 3, 5.5, 8, 10].map((r) => signalAffinity(type, r));
        for (let i = 1; i < values.length; i++) {
          expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
        }
      }
    });

    it('reste dans [-1, 1] sur toute combinaison', () => {
      for (const type of READER_LIST_TYPES) {
        for (const rating of [null, 1, 5.5, 7, 10]) {
          const w = signalAffinity(type, rating);
          expect(w).toBeGreaterThanOrEqual(-1);
          expect(w).toBeLessThanOrEqual(1);
        }
      }
    });

    it('ignore une note non finie', () => {
      expect(signalAffinity('complete', Number.NaN)).toBe(1);
    });
  });

  describe('pairContribution', () => {
    it('rapproche deux œuvres aimées par le même lecteur', () => {
      expect(pairContribution(1, 0.6)).toBeCloseTo(0.6);
    });

    it('ÉLOIGNE deux œuvres quand l’une est aimée et l’autre abandonnée', () => {
      // Le signal de répulsion : c'est lui qui manque totalement au produit.
      expect(pairContribution(1, -0.5)).toBeLessThan(0);
      expect(pairContribution(-0.5, 1)).toBeLessThan(0);
    });

    it('n’invente AUCUNE similarité entre deux abandons', () => {
      // Sans cette règle, (-0,5) × (-0,5) = +0,25 : « il a abandonné les
      // deux » deviendrait une raison de recommander.
      expect(pairContribution(-0.5, -0.5)).toBe(0);
      expect(pairContribution(-1, -0.25)).toBe(0);
      expect(pairContribution(0, -0.25)).toBe(0);
    });

    it('est symétrique', () => {
      const pairs: Array<[number, number]> = [
        [1, 0.25],
        [-0.5, 0.6],
        [-1, -1],
      ];
      for (const [a, b] of pairs) {
        expect(pairContribution(a, b)).toBe(pairContribution(b, a));
      }
    });
  });

  describe('cosineScore', () => {
    it('borne le score dans [-1, 1]', () => {
      expect(cosineScore(2, 2, 1)).toBe(1);
      expect(cosineScore(-2, 2, 1)).toBe(-1);
    });

    it('rend comparables une paire populaire et une paire de niche', () => {
      // Même « forme » de signal, volumes très différents → même score.
      expect(cosineScore(100, 10, 10)).toBeCloseTo(cosineScore(1, 1, 1));
    });

    it('renvoie 0 quand une norme est nulle (aucune information)', () => {
      expect(cosineScore(5, 0, 3)).toBe(0);
      expect(cosineScore(5, 3, 0)).toBe(0);
    });
  });

  describe('parité TypeScript ↔ SQL', () => {
    it('génère le SQL depuis les MÊMES constantes', () => {
      const sql = affinitySqlExpression('rs');
      for (const type of READER_LIST_TYPES) {
        expect(sql).toContain(`WHEN '${type}' THEN`);
        expect(sql).toContain(String(LIST_TYPE_AFFINITY[type]));
      }
      // La règle du minimum et le bornage doivent être présents côté SQL.
      expect(sql).toContain('LEAST');
      expect(sql).toContain('GREATEST(-1');
      expect(sql).toContain('rs.rating');
    });

    it('génère la contribution de paire avec le garde deux-négatifs', () => {
      const sql = pairContributionSql('a.w', 'b.w');
      expect(sql).toBe(
        'CASE WHEN a.w <= 0 AND b.w <= 0 THEN 0 ELSE a.w * b.w END',
      );
    });
  });

  describe('isReaderListType', () => {
    it('reconnaît les cinq types MU et rien d’autre', () => {
      for (const type of READER_LIST_TYPES) {
        expect(isReaderListType(type)).toBe(true);
      }
      expect(isReaderListType('dropped')).toBe(false);
      expect(isReaderListType(undefined)).toBe(false);
      expect(isReaderListType(2)).toBe(false);
    });
  });
});
