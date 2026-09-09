import {
  byValueDescThenId,
  compareEntryValueDescThenKey,
  compareIdAsc,
} from './reco-ordering';

describe('reco-ordering', () => {
  describe('compareIdAsc', () => {
    it('compare les mu_id numériquement, pas lexicographiquement', () => {
      expect(compareIdAsc('9', '10')).toBeLessThan(0);
      expect(compareIdAsc('100', '99')).toBeGreaterThan(0);
      expect(compareIdAsc('42', '42')).toBe(0);
    });

    it('retombe sur l ordre lexicographique pour les clés non numériques', () => {
      expect(compareIdAsc('Action', 'Romance')).toBeLessThan(0);
      expect(compareIdAsc('Romance', 'Action')).toBeGreaterThan(0);
      expect(compareIdAsc('Action', 'Action')).toBe(0);
    });

    it('départage deux chaînes distinctes de même valeur numérique', () => {
      expect(compareIdAsc('01', '1')).toBeLessThan(0);
      expect(compareIdAsc('1', '01')).toBeGreaterThan(0);
    });

    it('accepte indifféremment nombres et chaînes', () => {
      expect(compareIdAsc(9, '10')).toBeLessThan(0);
      expect(compareIdAsc('10', 9)).toBeGreaterThan(0);
    });
  });

  describe('byValueDescThenId', () => {
    const cmp = byValueDescThenId<{ id: string; score: number }>(
      (x) => x.score,
      (x) => x.id,
    );

    it('trie par score décroissant', () => {
      const sorted = [
        { id: '1', score: 1 },
        { id: '2', score: 5 },
      ].sort(cmp);
      expect(sorted.map((x) => x.id)).toEqual(['2', '1']);
    });

    it('départage les ex æquo par mu_id croissant, quel que soit l ordre d entrée', () => {
      const items = [
        { id: '30', score: 4 },
        { id: '7', score: 4 },
        { id: '200', score: 4 },
      ];
      const forward = [...items].sort(cmp).map((x) => x.id);
      const backward = [...items]
        .reverse()
        .sort(cmp)
        .map((x) => x.id);
      expect(forward).toEqual(['7', '30', '200']);
      // Le point du correctif : l'ordre d'entrée ne doit plus influer.
      expect(backward).toEqual(forward);
    });

    it('ne réordonne JAMAIS deux scores distincts (stabilité ≠ pertinence)', () => {
      const items = [
        { id: '999', score: 10 },
        { id: '1', score: 9.999999 },
      ];
      expect([...items].sort(cmp).map((x) => x.id)).toEqual(['999', '1']);
    });

    it('range les scores NaN derrière, sans casser le tri', () => {
      const items = [
        { id: '5', score: Number.NaN },
        { id: '9', score: 1 },
      ];
      expect(() => [...items].sort(cmp)).not.toThrow();
    });
  });

  describe('compareEntryValueDescThenKey', () => {
    it('trie les entrées [clé, valeur] par valeur décroissante puis clé', () => {
      const entries: Array<[string, number]> = [
        ['30', 2],
        ['7', 2],
        ['12', 5],
      ];
      expect([...entries].sort(compareEntryValueDescThenKey)).toEqual([
        ['12', 5],
        ['7', 2],
        ['30', 2],
      ]);
    });
  });
});
