import {
  extractDiscoveredReaders,
  extractListEntries,
  extractPublicLists,
  normalizeRating,
  pagesNeeded,
} from './mu-lists.mapper';

/**
 * Payloads COPIÉS de réponses réelles de l'API MangaUpdates, relevées le
 * 2026-09-09 en anonyme (pseudos remplacés par des valeurs neutres — ce sont
 * précisément les champs que le mapper doit jeter).
 */
const SIMILAR_BODY = {
  total_hits: 3,
  users: [
    {
      user_id: 75503901,
      user_name: 'un-pseudo-public',
      user_rating: null,
      intersect_count: null,
      percent_match: null,
    },
    {
      user_id: 114128543,
      user_name: 'un-autre-pseudo',
      user_rating: 8.5,
      intersect_count: null,
      percent_match: null,
    },
    {
      user_id: 287262746,
      user_name: 'troisieme',
      user_rating: 10,
      intersect_count: null,
      percent_match: null,
    },
  ],
};

const PUBLIC_LISTS_BODY = [
  {
    list_id: 0,
    title: 'Reading List',
    description: 'You are currently reading these series',
    type: 'read',
    icon: null,
    custom: false,
  },
  {
    list_id: 1,
    title: 'Wish List',
    description: 'You want to read this series eventually',
    type: 'wish',
    icon: null,
    custom: false,
  },
  {
    list_id: 2,
    title: 'Complete List',
    description: 'You have completely finished these series',
    type: 'complete',
    icon: null,
    custom: false,
  },
  {
    list_id: 4,
    title: 'On Hold List',
    description: 'You think you might finish this later',
    type: 'hold',
    icon: null,
    custom: false,
  },
];

/** Liste dont le propriétaire expose ses notes (`options.show_rating`). */
const LIST_SEARCH_WITH_RATING = {
  total_hits: 100,
  page: 1,
  per_page: 500,
  list: {
    list_id: 2,
    title: 'Complete List',
    type: 'complete',
    custom: false,
    options: { public: true, show_rating: true, show_latest_chapter: true },
  },
  results: [
    {
      series_id: 15180124327,
      series_title: 'Solo Leveling',
      series_url: 'https://www.mangaupdates.com/series/6z1uqw7/solo-leveling',
      metadata: { user_rating: 8.5, user_comment: { comment_id: null } },
    },
  ],
};

/** Même endpoint, propriétaire qui masque ses notes : pas de `user_rating`. */
const LIST_SEARCH_WITHOUT_RATING = {
  total_hits: 153,
  page: 1,
  per_page: 500,
  list: {
    list_id: 2,
    type: 'complete',
    options: { public: true, show_rating: false },
  },
  results: [
    {
      series_id: 52570708100,
      series_title: 'A Pair of Childhood Friends…',
      series_url: 'https://www.mangaupdates.com/series/o5f8pz8/a-pair…',
      metadata: { user_comment: { comment_id: null } },
    },
  ],
};

describe('mu-lists.mapper', () => {
  describe('extractDiscoveredReaders', () => {
    it('mappe une réponse /lists/similar réelle', () => {
      const readers = extractDiscoveredReaders(SIMILAR_BODY);
      expect(readers).toEqual([
        { userId: '75503901', rating: null },
        { userId: '114128543', rating: 8.5 },
        { userId: '287262746', rating: 10 },
      ]);
    });

    it('ne retient AUCUN champ identifiant (RGPD)', () => {
      const readers = extractDiscoveredReaders(SIMILAR_BODY);
      // La sortie ne doit exposer que ces deux clés — surtout pas de pseudo.
      for (const reader of readers) {
        expect(Object.keys(reader).sort()).toEqual(['rating', 'userId']);
      }
      const serialized = JSON.stringify(readers);
      expect(serialized).not.toContain('user_name');
      expect(serialized).not.toContain('un-pseudo-public');
      expect(serialized).not.toContain('un-autre-pseudo');
    });

    it('tolère une série sans aucun lecteur', () => {
      expect(extractDiscoveredReaders({ total_hits: 0, users: [] })).toEqual(
        [],
      );
      expect(extractDiscoveredReaders({})).toEqual([]);
      expect(extractDiscoveredReaders(null)).toEqual([]);
    });

    it('écarte les entrées sans identifiant exploitable', () => {
      const readers = extractDiscoveredReaders({
        users: [
          { user_name: 'sans-id' },
          { user_id: 'abc' },
          { user_id: 0 },
          { user_id: '42', user_rating: 7 },
        ],
      });
      expect(readers).toEqual([{ userId: '42', rating: 7 }]);
    });

    it('dédoublonne un lecteur en gardant la note connue', () => {
      const readers = extractDiscoveredReaders({
        users: [
          { user_id: 5, user_rating: null },
          { user_id: 5, user_rating: 9 },
        ],
      });
      expect(readers).toEqual([{ userId: '5', rating: 9 }]);
    });
  });

  describe('extractPublicLists', () => {
    it('mappe une réponse /lists/public réelle, list_id 0 inclus', () => {
      expect(extractPublicLists(PUBLIC_LISTS_BODY)).toEqual([
        { listId: '0', listType: 'read' },
        { listId: '1', listType: 'wish' },
        { listId: '2', listType: 'complete' },
        { listId: '4', listType: 'hold' },
      ]);
    });

    it('conserve DEUX listes du même type (listes personnalisées)', () => {
      // Cas réel : un compte expose « read / complete / read », la troisième
      // étant une liste custom dérivée de la Reading List.
      const lists = extractPublicLists([
        { list_id: 0, type: 'read' },
        { list_id: 2, type: 'complete' },
        { list_id: 17, type: 'read', custom: true },
      ]);
      expect(lists).toHaveLength(3);
      expect(lists.map((l) => l.listId)).toEqual(['0', '2', '17']);
    });

    it('ignore un type inconnu plutôt que de le deviner', () => {
      expect(
        extractPublicLists([
          { list_id: 9, type: 'exotique' },
          { list_id: 2, type: 'complete' },
        ]),
      ).toEqual([{ listId: '2', listType: 'complete' }]);
    });

    it('tolère un compte sans aucune liste publique', () => {
      expect(extractPublicLists([])).toEqual([]);
      expect(extractPublicLists(null)).toEqual([]);
    });
  });

  describe('extractListEntries', () => {
    it('mappe une liste qui expose les notes', () => {
      expect(extractListEntries(LIST_SEARCH_WITH_RATING, 'complete')).toEqual([
        { muId: '15180124327', listType: 'complete', rating: 8.5 },
      ]);
    });

    it('mappe une liste qui masque les notes (rating null, pas d’erreur)', () => {
      expect(
        extractListEntries(LIST_SEARCH_WITHOUT_RATING, 'complete'),
      ).toEqual([{ muId: '52570708100', listType: 'complete', rating: null }]);
    });

    it('ne retient ni le titre ni l’URL de la série', () => {
      const rows = extractListEntries(LIST_SEARCH_WITH_RATING, 'complete');
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('Solo Leveling');
      expect(serialized).not.toContain('mangaupdates.com');
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(['listType', 'muId', 'rating']);
      }
    });

    it('tolère une liste vide', () => {
      expect(extractListEntries({ results: [] }, 'read')).toEqual([]);
      expect(extractListEntries(null, 'read')).toEqual([]);
    });
  });

  describe('normalizeRating', () => {
    it('accepte l’échelle MU et arrondit au centième', () => {
      expect(normalizeRating(8.5)).toBe(8.5);
      expect(normalizeRating('9')).toBe(9);
      expect(normalizeRating(7.239)).toBe(7.24);
    });

    it('renvoie null plutôt qu’une valeur inventée', () => {
      expect(normalizeRating(null)).toBeNull();
      expect(normalizeRating(undefined)).toBeNull();
      expect(normalizeRating('')).toBeNull();
      expect(normalizeRating('abc')).toBeNull();
      // Hors échelle MU (1-10) : donnée aberrante, pas une note.
      expect(normalizeRating(0)).toBeNull();
      expect(normalizeRating(11)).toBeNull();
    });
  });

  describe('pagesNeeded', () => {
    it('tient dans une seule page à perpage 1000 (cas courant)', () => {
      expect(pagesNeeded(926, 1000, 3)).toBe(1);
      expect(pagesNeeded(153, 1000, 3)).toBe(1);
    });

    it('pagine au-delà, sans dépasser le plafond', () => {
      expect(pagesNeeded(2500, 1000, 3)).toBe(3);
      expect(pagesNeeded(50_000, 1000, 3)).toBe(3);
    });

    it('ne demande rien pour une liste vide ou un total illisible', () => {
      expect(pagesNeeded(0, 1000, 3)).toBe(0);
      expect(pagesNeeded(undefined, 1000, 3)).toBe(0);
    });

    it('tient compte d’une coercition de perpage par MU', () => {
      // MU coerce silencieusement > 1000 à 25 : sans en tenir compte, on
      // croirait avoir tout lu avec une seule page.
      expect(pagesNeeded(900, 25, 10)).toBe(10);
    });
  });
});
