import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import {
  buildGraphSourceContexts,
  CATEGORY_TOP_CONTRIBUTION,
  GraphLinkRow,
  MAX_CATEGORY_LINKS_PER_SOURCE,
  RELATED_CONTRIBUTION,
  scoreGraphLinks,
} from './reco-graph-scoring';

const NOW = new Date('2026-09-09T00:00:00.000Z').getTime();

function makeUserManga(
  muId: string,
  readingStatus: string,
  userRating = 0,
  type: string | null = 'Manhwa',
): UserManga {
  const manga = new Manga();
  manga.mu_id = muId;
  manga.type = type;
  const um = new UserManga();
  um.manga = manga;
  um.readingStatus = readingStatus as UserManga['readingStatus'];
  um.user_rating = userRating;
  // Ajouté à l'instant : multiplicateur de récence ≈ 1, scores lisibles.
  um.adding_date = new Date(NOW);
  return um;
}

function link(
  source: string,
  target: string,
  kind: GraphLinkRow['kind'],
  weight: number,
  relationType: string | null = null,
): GraphLinkRow {
  return {
    source_mu_id: source,
    recommended_mu_id: target,
    kind,
    relation_type: relationType,
    weight,
  };
}

describe('buildGraphSourceContexts', () => {
  it('ne retient que les œuvres appréciées (statut fort ou note ≥ 7)', () => {
    const contexts = buildGraphSourceContexts(
      [
        makeUserManga('1', 'completed'),
        makeUserManga('2', 'caughtUp'),
        makeUserManga('3', 'reading'),
        makeUserManga('4', 'readLater'),
        makeUserManga('5', 'readLater', 8),
      ],
      NOW,
    );

    expect([...contexts.keys()].sort()).toEqual(['1', '2', '3', '5']);
  });

  it('marque « terminé » les seuls statuts completed / caughtUp', () => {
    const contexts = buildGraphSourceContexts(
      [
        makeUserManga('1', 'completed'),
        makeUserManga('2', 'caughtUp'),
        makeUserManga('3', 'reading'),
      ],
      NOW,
    );

    expect(contexts.get('1')?.finished).toBe(true);
    expect(contexts.get('2')?.finished).toBe(true);
    expect(contexts.get('3')?.finished).toBe(false);
  });

  it('reproduit le multiplicateur du chemin historique (statut × note × récence)', () => {
    const contexts = buildGraphSourceContexts(
      [makeUserManga('1', 'completed', 10)],
      NOW,
    );

    // 10/5 × 1.5 × exp(0) = 3
    expect(contexts.get('1')?.multiplier).toBeCloseTo(3, 6);
  });
});

describe('scoreGraphLinks — normalisation', () => {
  const contexts = buildGraphSourceContexts(
    [makeUserManga('S1', 'completed'), makeUserManga('S2', 'reading')],
    NOW,
  );

  it('ramène les poids `category` à un rang relatif À LA SOURCE', () => {
    // S1 (série populaire) et S2 (série de niche) ont des poids absolus sans
    // commune mesure : après normalisation, leur MEILLEUR voisin vaut la même
    // contribution de base — seule la préférence utilisateur les départage.
    const rows = [
      link('S1', 'A', 'category', 38432),
      link('S1', 'B', 'category', 19216),
      link('S2', 'C', 'category', 300),
    ];
    const scored = scoreGraphLinks(rows, contexts, new Set());
    const byTarget = new Map(scored.map((c) => [c.muId, c.score]));

    // S1 : completed, pas de note → multiplicateur 1.5
    expect(byTarget.get('A')).toBeCloseTo(CATEGORY_TOP_CONTRIBUTION * 1.5, 6);
    expect(byTarget.get('B')).toBeCloseTo(
      CATEGORY_TOP_CONTRIBUTION * 0.5 * 1.5,
      6,
    );
    // S2 : reading → multiplicateur 1.2, malgré un poids MU 128× plus petit
    expect(byTarget.get('C')).toBeCloseTo(CATEGORY_TOP_CONTRIBUTION * 1.2, 6);
  });

  it('reste dans le même ordre de grandeur que les poids `manual`', () => {
    // Les poids manual observés en prod vont de 2 à 220 (moyenne 12) : une
    // contribution de catégorie ne doit ni disparaître ni tout écraser.
    const scored = scoreGraphLinks(
      [link('S1', 'A', 'category', 38432)],
      contexts,
      new Set(),
    );
    expect(scored[0].score).toBeGreaterThan(12);
    expect(scored[0].score).toBeLessThan(220);
  });

  it('plafonne le nombre de voisins `category` retenus par source', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      link('S1', `T${i}`, 'category', 1000 - i),
    );
    const scored = scoreGraphLinks(rows, contexts, new Set());

    expect(scored).toHaveLength(MAX_CATEGORY_LINKS_PER_SOURCE);
    // Les mieux pondérés sont conservés.
    expect(scored[0].muId).toBe('T0');
  });
});

describe('scoreGraphLinks — liens de parenté', () => {
  it('ne propose une suite que si la source est terminée ou à jour', () => {
    const contexts = buildGraphSourceContexts(
      [makeUserManga('S1', 'completed'), makeUserManga('S2', 'reading')],
      NOW,
    );
    const rows = [
      link('S1', 'SUITE1', 'related', 0, 'Sequel'),
      link('S2', 'SUITE2', 'related', 0, 'Sequel'),
    ];
    const scored = scoreGraphLinks(rows, contexts, new Set());

    expect(scored.map((c) => c.muId)).toEqual(['SUITE1']);
    expect(scored[0].score).toBeCloseTo(RELATED_CONTRIBUTION * 1.5, 6);
  });

  it('écarte les relations « même œuvre, autre support »', () => {
    const contexts = buildGraphSourceContexts(
      [makeUserManga('S1', 'completed')],
      NOW,
    );
    const rows = [
      link('S1', 'ROMAN', 'related', 0, 'Adapted From'),
      link('S1', 'SPINOFF', 'related', 0, 'Spin-Off'),
    ];
    const scored = scoreGraphLinks(rows, contexts, new Set());

    expect(scored.map((c) => c.muId)).toEqual(['SPINOFF']);
  });

  it('reste sous la contribution de catégorie (complément, pas cœur de liste)', () => {
    expect(RELATED_CONTRIBUTION).toBeLessThan(CATEGORY_TOP_CONTRIBUTION);
  });
});

describe('scoreGraphLinks — exclusions et agrégation', () => {
  const contexts = buildGraphSourceContexts(
    [makeUserManga('S1', 'completed'), makeUserManga('S2', 'completed')],
    NOW,
  );

  it('exclut les titres possédés ou écartés', () => {
    const rows = [
      link('S1', 'POSSEDE', 'category', 1000),
      link('S1', 'REJETE', 'category', 900),
      link('S1', 'OK', 'category', 800),
    ];
    const scored = scoreGraphLinks(
      rows,
      contexts,
      new Set(['POSSEDE', 'REJETE']),
    );

    expect(scored.map((c) => c.muId)).toEqual(['OK']);
  });

  it('ignore les liens dont la source n’est pas une œuvre appréciée', () => {
    const rows = [link('INCONNUE', 'A', 'category', 1000)];
    expect(scoreGraphLinks(rows, contexts, new Set())).toEqual([]);
  });

  it('ignore les auto-références', () => {
    const rows = [link('S1', 'S1', 'category', 1000)];
    expect(scoreGraphLinks(rows, contexts, new Set())).toEqual([]);
  });

  it('produit une contribution par (source, cible) — le cumul est fait en aval', () => {
    const rows = [
      link('S1', 'CIBLE', 'category', 1000),
      link('S2', 'CIBLE', 'category', 1000),
      link('S1', 'CIBLE', 'related', 0, 'Sequel'),
    ];
    const scored = scoreGraphLinks(rows, contexts, new Set());

    expect(scored).toHaveLength(3);
    expect(scored.filter((c) => c.muId === 'CIBLE')).toHaveLength(3);
    expect(new Set(scored.map((c) => c.kind))).toEqual(
      new Set(['category', 'related']),
    );
  });
});
