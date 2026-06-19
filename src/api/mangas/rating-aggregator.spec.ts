import { aggregateRating, RATING_CONFIDENCE_WEIGHT } from './rating-aggregator';

describe('aggregateRating', () => {
  it('retourne MU rating si aucun vote local', () => {
    const r = aggregateRating(7.5, null, 0);
    expect(r.communityRating).toBeNull();
    expect(r.communityRatingCount).toBe(0);
    expect(r.aggregatedRating).toBe(7.5);
  });

  it('équilibre 50/50 quand localCount === confidenceWeight', () => {
    const r = aggregateRating(8.0, 6.0, RATING_CONFIDENCE_WEIGHT);
    // (50 * 8 + 50 * 6) / 100 = 7
    expect(r.aggregatedRating).toBe(7);
  });

  it('domine MU rating quand localCount >> confidenceWeight', () => {
    const r = aggregateRating(8.0, 5.0, 500);
    // (50 * 8 + 500 * 5) / 550 = (400 + 2500) / 550 ≈ 5.27
    expect(r.aggregatedRating).toBeCloseTo(5.27, 1);
  });

  it('1 vote local fait peu bouger MU rating', () => {
    const r = aggregateRating(8.0, 10.0, 1);
    // (50 * 8 + 1 * 10) / 51 ≈ 8.04
    expect(r.aggregatedRating).toBeCloseTo(8.04, 1);
  });

  it('retourne 0 si rien (ni MU ni local)', () => {
    const r = aggregateRating(null, null, 0);
    expect(r.aggregatedRating).toBe(0);
    expect(r.communityRating).toBeNull();
  });

  it('utilise local seul si MU absent', () => {
    const r = aggregateRating(0, 7.5, 10);
    expect(r.aggregatedRating).toBe(7.5);
    expect(r.communityRating).toBe(7.5);
  });

  it('expose communityRating uniquement quand il y a des votes locaux', () => {
    expect(aggregateRating(7, null, 0).communityRating).toBeNull();
    expect(aggregateRating(7, 8, 5).communityRating).toBe(8);
  });

  it("permet d'override le confidenceWeight", () => {
    // Avec C=10 au lieu de 50, la communauté pèse plus vite
    const r = aggregateRating(8, 6, 10, 10);
    // (10 * 8 + 10 * 6) / 20 = 7
    expect(r.aggregatedRating).toBe(7);
  });
});
