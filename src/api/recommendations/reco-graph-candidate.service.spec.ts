import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { RecoGraphCandidateService } from './reco-graph-candidate.service';
import { GraphLinkRow } from './reco-graph-scoring';
import { ScoredEntry } from './scored-entry.interface';

function makeUserManga(
  muId: string,
  readingStatus = 'completed',
  userRating = 0,
): UserManga {
  const manga = new Manga();
  manga.mu_id = muId;
  manga.type = 'Manhwa';
  const um = new UserManga();
  um.manga = manga;
  um.readingStatus = readingStatus as UserManga['readingStatus'];
  um.user_rating = userRating;
  um.adding_date = new Date();
  return um;
}

describe('RecoGraphCandidateService', () => {
  let service: RecoGraphCandidateService;
  let rows: GraphLinkRow[];
  let capturedWhere: Record<string, unknown>;
  let getRawMany: jest.Mock;

  beforeEach(async () => {
    rows = [];
    capturedWhere = {};
    getRawMany = jest.fn(async () => rows);

    const qb: Record<string, unknown> = {};
    const chain = (fn?: (...args: unknown[]) => void) =>
      jest.fn((...args: unknown[]) => {
        fn?.(...args);
        return qb;
      });
    Object.assign(qb, {
      select: chain(),
      addSelect: chain(),
      where: chain((_c, params) =>
        Object.assign(capturedWhere, params as object),
      ),
      andWhere: chain((_c, params) =>
        Object.assign(capturedWhere, params as object),
      ),
      getRawMany,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecoGraphCandidateService,
        {
          provide: getRepositoryToken(MangaRecommendation),
          useValue: { createQueryBuilder: jest.fn(() => qb) },
        },
      ],
    }).compile();
    service = module.get<RecoGraphCandidateService>(RecoGraphCandidateService);
  });

  it('ne lit que les liens `category` et `related` (jamais `manual`)', async () => {
    // `manual` est déjà consommé, avec son poids brut, par
    // `RecommendationService.scoreRecos` — le compter ici le doublerait.
    await service.augment(
      [makeUserManga('S1')],
      new Set(),
      new Map<string, ScoredEntry>(),
    );

    expect(capturedWhere.kinds).toEqual(['category', 'related']);
    expect(capturedWhere.sourceMuIds).toEqual(['S1']);
  });

  it('ajoute les voisins au pool et cumule les contributions multi-sources', async () => {
    rows = [
      {
        source_mu_id: 'S1',
        recommended_mu_id: 'CIBLE',
        kind: 'category',
        relation_type: null,
        weight: 1000,
      },
      {
        source_mu_id: 'S2',
        recommended_mu_id: 'CIBLE',
        kind: 'category',
        relation_type: null,
        weight: 1000,
      },
    ];
    const scoreMap = new Map<string, ScoredEntry>();

    const added = await service.augment(
      [makeUserManga('S1'), makeUserManga('S2')],
      new Set(),
      scoreMap,
    );

    expect(added).toBe(1);
    const entry = scoreMap.get('CIBLE') as ScoredEntry;
    expect(entry.sources.size).toBe(2);
    expect(entry.score).toBeCloseTo(
      (entry.sources.get('S1') ?? 0) + (entry.sources.get('S2') ?? 0),
      6,
    );
  });

  it('ADDITIONNE sa contribution à une entrée déjà scorée par le chemin manuel', async () => {
    // Contrairement au catalogue local (qui ne double jamais un score MU) :
    // un titre à la fois recommandé manuellement et voisin de catégorie est
    // un meilleur candidat que chacun des deux signaux isolément.
    rows = [
      {
        source_mu_id: 'S1',
        recommended_mu_id: 'CIBLE',
        kind: 'category',
        relation_type: null,
        weight: 1000,
      },
    ];
    const scoreMap = new Map<string, ScoredEntry>([
      ['CIBLE', { score: 100, sources: new Map([['S1', 100]]) }],
    ]);

    const added = await service.augment(
      [makeUserManga('S1')],
      new Set(),
      scoreMap,
    );

    expect(added).toBe(0);
    expect((scoreMap.get('CIBLE') as ScoredEntry).score).toBeGreaterThan(100);
  });

  it('respecte le set d’exclusion (bibliothèque ∪ titres écartés)', async () => {
    rows = [
      {
        source_mu_id: 'S1',
        recommended_mu_id: 'REJETE',
        kind: 'category',
        relation_type: null,
        weight: 1000,
      },
    ];
    const scoreMap = new Map<string, ScoredEntry>();

    const added = await service.augment(
      [makeUserManga('S1')],
      new Set(['REJETE']),
      scoreMap,
    );

    expect(added).toBe(0);
    expect(scoreMap.size).toBe(0);
  });

  it('n’interroge pas la base quand aucune œuvre n’est appréciée', async () => {
    const added = await service.augment(
      [makeUserManga('S1', 'readLater')],
      new Set(),
      new Map<string, ScoredEntry>(),
    );

    expect(added).toBe(0);
    expect(getRawMany).not.toHaveBeenCalled();
  });

  it('dégrade sans lever quand la base est indisponible', async () => {
    getRawMany.mockRejectedValue(new Error('connection reset'));
    const scoreMap = new Map<string, ScoredEntry>();

    await expect(
      service.augment([makeUserManga('S1')], new Set(), scoreMap),
    ).resolves.toBe(0);
    expect(scoreMap.size).toBe(0);
  });
});
