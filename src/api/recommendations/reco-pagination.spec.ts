import {
  clampRecoWindow,
  RECO_DEFAULT_LIMIT,
  paginate,
  RECO_CANONICAL_MAX_ITEMS_CEILING,
  RECO_DEFAULT_CANONICAL_MAX_ITEMS,
  RECO_MAX_LIMIT,
  recoCanonicalMaxItems,
} from './reco-pagination';

describe('reco-pagination', () => {
  describe('clampRecoWindow', () => {
    it('laisse passer une fenêtre valide', () => {
      expect(clampRecoWindow(50, 100)).toEqual({ limit: 50, offset: 100 });
    });

    it("borne un limit négatif au plancher — c'est le bug du slice(0, -1)", () => {
      expect(clampRecoWindow(-1, 0).limit).toBe(1);
    });

    it('borne un limit nul au plancher', () => {
      expect(clampRecoWindow(0, 0).limit).toBe(1);
    });

    it('borne un limit excessif au plafond', () => {
      expect(clampRecoWindow(10_000, 0).limit).toBe(RECO_MAX_LIMIT);
    });

    it('ramène un offset négatif à 0', () => {
      expect(clampRecoWindow(10, -5).offset).toBe(0);
    });

    it('tronque les décimales plutôt que de les propager dans un slice', () => {
      expect(clampRecoWindow(10.9, 5.9)).toEqual({ limit: 10, offset: 5 });
    });

    it('retombe sur la taille de page par défaut quand l entrée n est pas finie', () => {
      // `NaN` / `Infinity` ne traduisent pas une intention de pagination :
      // on rend la page par défaut plutôt que le plafond.
      expect(clampRecoWindow(Number.NaN, Number.NaN)).toEqual({
        limit: RECO_DEFAULT_LIMIT,
        offset: 0,
      });
      expect(clampRecoWindow(Number.POSITIVE_INFINITY, 0).limit).toBe(
        RECO_DEFAULT_LIMIT,
      );
    });
  });

  describe('recoCanonicalMaxItems', () => {
    it('vaut la limite max d une page par défaut', () => {
      expect(recoCanonicalMaxItems({})).toBe(RECO_DEFAULT_CANONICAL_MAX_ITEMS);
      expect(RECO_DEFAULT_CANONICAL_MAX_ITEMS).toBe(RECO_MAX_LIMIT);
    });

    it('ignore une valeur non numérique', () => {
      expect(
        recoCanonicalMaxItems({ RECO_CANONICAL_MAX_ITEMS: 'beaucoup' }),
      ).toBe(RECO_DEFAULT_CANONICAL_MAX_ITEMS);
    });

    it('ne descend jamais sous RECO_MAX_LIMIT — sinon une page limit=500 serait tronquée', () => {
      expect(recoCanonicalMaxItems({ RECO_CANONICAL_MAX_ITEMS: '10' })).toBe(
        RECO_MAX_LIMIT,
      );
    });

    it('plafonne pour borner la mémoire du cache', () => {
      expect(recoCanonicalMaxItems({ RECO_CANONICAL_MAX_ITEMS: '99999' })).toBe(
        RECO_CANONICAL_MAX_ITEMS_CEILING,
      );
    });

    it('accepte une valeur intermédiaire', () => {
      expect(recoCanonicalMaxItems({ RECO_CANONICAL_MAX_ITEMS: '900' })).toBe(
        900,
      );
    });
  });

  describe('paginate', () => {
    const items = [1, 2, 3, 4, 5];

    it('rend la tranche demandée', () => {
      expect(paginate(items, { limit: 2, offset: 1 })).toEqual([2, 3]);
    });

    it('rend un tableau vide au-delà de la liste', () => {
      expect(paginate(items, { limit: 10, offset: 99 })).toEqual([]);
    });

    it('garantit que toute page est un préfixe de la liste canonique', () => {
      const small = paginate(items, { limit: 2, offset: 0 });
      const large = paginate(items, { limit: 5, offset: 0 });
      expect(large.slice(0, small.length)).toEqual(small);
    });
  });
});
