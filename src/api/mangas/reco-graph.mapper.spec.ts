import {
  isDiscoverableRelation,
  mapSeriesNeighbourhood,
} from './reco-graph.mapper';

/**
 * Mapping des TROIS champs de voisinage de `GET /v1/series/{id}`.
 *
 * Les fixtures reprennent la forme réellement observée le 2026-09-09 sur
 * Solo Leveling (`15180124327`) : `recommendations` à poids 2-3,
 * `category_recommendations` à poids 27 000-38 000, `related_series` avec
 * `relation_type`. Le format imbriqué historique (`series_id` objet) est
 * testé en parallèle — c'est le fallback décrit dans le commentaire
 * « Format MU 2026-05 » de `MangaDetailsDto.fromMU`.
 */
describe('mapSeriesNeighbourhood', () => {
  const SOLO_LEVELING = 15180124327;

  const flatPayload = {
    series_id: SOLO_LEVELING,
    type: 'Manhwa',
    recommendations: [
      {
        series_name: 'Kimetsu no Yaiba',
        series_id: 36271319846,
        series_image: {
          url: {
            original: 'https://cdn.mangaupdates.com/image/i525117.jpg',
            thumb: 'https://cdn.mangaupdates.com/image/thumb/i525117.jpg',
          },
        },
        weight: 3,
      },
      { series_name: 'Vinland Saga', series_id: 1, weight: 2 },
    ],
    category_recommendations: [
      {
        series_name: 'Solo Leveling: Ragnarok',
        series_id: 47955563021,
        series_image: {
          url: {
            original: 'https://cdn.mangaupdates.com/image/i505562.jpg',
            thumb: 'https://cdn.mangaupdates.com/image/thumb/i505562.jpg',
          },
        },
        weight: 38432,
      },
      { series_name: 'I Am the Sorcerer King', series_id: 2, weight: 27749 },
    ],
    related_series: [
      {
        relation_type: 'Sequel',
        related_series_id: 47955563021,
        related_series_name: 'Solo Leveling: Ragnarok',
      },
      {
        relation_type: 'Adapted From',
        related_series_id: 13184758110,
        related_series_name: 'Solo Leveling (Novel)',
      },
    ],
  };

  it('lit les trois champs du format plat (MU 2026-05)', () => {
    const result = mapSeriesNeighbourhood(SOLO_LEVELING, flatPayload);

    expect(result.manual).toHaveLength(2);
    expect(result.manual[0]).toEqual({
      seriesId: 36271319846,
      title: 'Kimetsu no Yaiba',
      weight: 3,
      smallCoverUrl: 'https://cdn.mangaupdates.com/image/thumb/i525117.jpg',
      mediumCoverUrl: 'https://cdn.mangaupdates.com/image/i525117.jpg',
    });

    expect(result.category).toHaveLength(2);
    expect(result.category[0].seriesId).toBe(47955563021);
    expect(result.category[0].weight).toBe(38432);

    expect(result.related).toEqual([
      {
        seriesId: 47955563021,
        title: 'Solo Leveling: Ragnarok',
        relationType: 'Sequel',
      },
      {
        seriesId: 13184758110,
        title: 'Solo Leveling (Novel)',
        relationType: 'Adapted From',
      },
    ]);
  });

  it('remonte le `type` de la série source (gratuit, sert le prorata)', () => {
    expect(mapSeriesNeighbourhood(SOLO_LEVELING, flatPayload).sourceType).toBe(
      'Manhwa',
    );
  });

  it('gère le format imbriqué historique (`series_id` objet)', () => {
    const nested = {
      recommendations: [
        {
          series_id: {
            series_id: 999,
            title: 'Ancien format',
            image: { url: { original: 'o.jpg', thumb: 't.jpg' } },
          },
          weight: 12,
        },
      ],
      category_recommendations: [
        {
          series_id: { series_id: 1000, series_name: 'Sans title' },
          weight: 5000,
        },
      ],
    };
    const result = mapSeriesNeighbourhood(SOLO_LEVELING, nested);

    expect(result.manual[0]).toEqual({
      seriesId: 999,
      title: 'Ancien format',
      weight: 12,
      smallCoverUrl: 't.jpg',
      mediumCoverUrl: 'o.jpg',
    });
    expect(result.category[0].seriesId).toBe(1000);
    expect(result.category[0].title).toBe('Sans title');
  });

  it('écarte les poids nuls/négatifs, les ids invalides et les auto-références', () => {
    const noisy = {
      recommendations: [
        { series_id: 10, series_name: 'Poids zéro', weight: 0 },
        { series_id: 11, series_name: 'Poids négatif', weight: -4 },
        { series_id: 'abc', series_name: 'Id non numérique', weight: 5 },
        { series_id: SOLO_LEVELING, series_name: 'Elle-même', weight: 9 },
        { series_id: 12, series_name: 'Valide', weight: 5 },
      ],
      related_series: [
        { related_series_id: SOLO_LEVELING, relation_type: 'Sequel' },
        { relation_type: 'Sequel' },
      ],
    };
    const result = mapSeriesNeighbourhood(SOLO_LEVELING, noisy);

    expect(result.manual.map((l) => l.seriesId)).toEqual([12]);
    expect(result.related).toEqual([]);
  });

  it('dédoublonne par cible en gardant le poids le plus fort', () => {
    // Indispensable : PostgreSQL refuse un ON CONFLICT DO UPDATE qui
    // toucherait deux fois la même ligne dans un seul INSERT.
    const duplicated = {
      category_recommendations: [
        { series_id: 42, series_name: 'A', weight: 100 },
        { series_id: 42, series_name: 'A', weight: 900 },
        { series_id: 43, series_name: 'B', weight: 50 },
      ],
      related_series: [
        { related_series_id: 42, relation_type: 'Sequel' },
        { related_series_id: 42, relation_type: 'Side Story' },
      ],
    };
    const result = mapSeriesNeighbourhood(SOLO_LEVELING, duplicated);

    expect(result.category).toHaveLength(2);
    expect(result.category.find((l) => l.seriesId === 42)?.weight).toBe(900);
    expect(result.related).toHaveLength(1);
  });

  it('ne lève jamais sur un payload vide, partiel ou aberrant', () => {
    for (const payload of [null, undefined, 42, 'texte', [], {}]) {
      const result = mapSeriesNeighbourhood(SOLO_LEVELING, payload);
      expect(result).toEqual({
        manual: [],
        category: [],
        related: [],
        sourceType: null,
      });
    }
    expect(
      mapSeriesNeighbourhood(SOLO_LEVELING, {
        recommendations: 'pas un tableau',
        category_recommendations: null,
      }).manual,
    ).toEqual([]);
  });
});

describe('isDiscoverableRelation', () => {
  it('écarte les relations « même œuvre, autre support »', () => {
    expect(isDiscoverableRelation('Adapted From')).toBe(false);
    expect(isDiscoverableRelation('adaptation')).toBe(false);
    expect(isDiscoverableRelation(' Alternate Version ')).toBe(false);
  });

  it('conserve les œuvres réellement distinctes', () => {
    for (const relation of [
      'Sequel',
      'Prequel',
      'Side Story',
      'Spin-Off',
      'Main Story',
      null,
    ]) {
      expect(isDiscoverableRelation(relation)).toBe(true);
    }
  });
});
