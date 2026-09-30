import {
  aggregateRating,
  muVotesByMuId,
  RATING_CONFIDENCE_WEIGHT,
} from './rating-aggregator';

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

  describe('fusion au prorata des votes (votants MU connus)', () => {
    it('chaque vote pèse autant : 3 votes MU à 8 + 1 vote local à 4 → 7', () => {
      const r = aggregateRating(8, 4, 1, RATING_CONFIDENCE_WEIGHT, 3);
      expect(r.aggregatedRating).toBe(7);
      expect(r.muRatingVotes).toBe(3);
      expect(r.totalRatingVotes).toBe(4);
    });

    it('un titre très voté chez MU bouge à peine avec quelques votes locaux', () => {
      const r = aggregateRating(8.5, 10, 2, RATING_CONFIDENCE_WEIGHT, 5000);
      expect(r.aggregatedRating).toBe(8.5);
      expect(r.totalRatingVotes).toBe(5002);
    });

    it('sans vote local : note MU, total = votants MU', () => {
      const r = aggregateRating(7.2, null, 0, RATING_CONFIDENCE_WEIGHT, 120);
      expect(r.aggregatedRating).toBe(7.2);
      expect(r.totalRatingVotes).toBe(120);
    });

    it('votants MU inconnus : repli sur le poids historique, total = locaux', () => {
      const r = aggregateRating(
        8,
        6,
        RATING_CONFIDENCE_WEIGHT,
        undefined,
        null,
      );
      expect(r.aggregatedRating).toBe(7);
      expect(r.muRatingVotes).toBeNull();
      expect(r.totalRatingVotes).toBe(RATING_CONFIDENCE_WEIGHT);
    });

    it('pas de note MU : les votants MU ne comptent pas', () => {
      const r = aggregateRating(0, 9, 2, RATING_CONFIDENCE_WEIGHT, 40);
      expect(r.aggregatedRating).toBe(9);
      expect(r.muRatingVotes).toBeNull();
      expect(r.totalRatingVotes).toBe(2);
    });
  });
});

describe('muVotesByMuId', () => {
  it('should keep only known, positive MangaUpdates vote counts', () => {
    const votes = muVotesByMuId([
      { mu_id: '1', rating_votes: 40 },
      { mu_id: '2', rating_votes: null },
      { mu_id: '3', rating_votes: 0 },
      { mu_id: '4' },
    ]);
    expect([...votes.entries()]).toEqual([['1', 40]]);
  });
});
