import { HttpService } from '@nestjs/axios';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { of, throwError } from 'rxjs';
import { CatalogPageIngestService } from './catalog-page-ingest.service';
import { CatalogShard } from './catalog-shard';
import { Manga } from './manga.entity';

/** Réponse MU search : `count` records à partir de `firstId`. */
function muPage(
  firstId: number,
  count: number,
  totalHits: number,
  opts?: { withGenres?: boolean },
) {
  const withGenres = opts?.withGenres ?? true;
  return {
    data: {
      total_hits: totalHits,
      results: Array.from({ length: count }, (_, i) => ({
        record: {
          series_id: firstId + i,
          title: `Manga ${firstId + i}`,
          year: '2020',
          bayesian_rating: 8.1,
          image: {
            url: {
              original: `https://cdn/${firstId + i}.jpg`,
              thumb: `https://cdn/${firstId + i}-t.jpg`,
            },
          },
          genres: withGenres ? [{ genre: 'Action' }] : undefined,
        },
      })),
    },
  };
}

function axiosError(status: number) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: { status },
  };
}

interface InsertCall {
  values: Array<Record<string, unknown>>;
  orUpdateCols: string[];
}

const RATING_SHARD: CatalogShard = {
  jobName: 'catalog:rating',
  kind: 'global',
  level: 0,
  orderby: 'rating',
};

/**
 * Tests de l'ingestion d'une page (appel MU + backoff + upsert), extraits de
 * `catalog-sync.service.spec.ts` avec `CatalogPageIngestService`
 * (2026-08-28). Le backoff et la doctrine null-safe de l'upsert sont des
 * comportements de NON-RÉGRESSION : ils ne changent pas avec le découpage.
 */
describe('CatalogPageIngestService', () => {
  let service: CatalogPageIngestService;
  let postMock: jest.Mock;
  let mangaRepo: { createQueryBuilder: jest.Mock };
  let insertCalls: InsertCall[];
  let sleepMock: jest.Mock;

  function makeInsertQb() {
    const captured: Partial<InsertCall> = {};
    const qb = {
      insert: jest.fn(() => qb),
      into: jest.fn(() => qb),
      values: jest.fn((v: Array<Record<string, unknown>>) => {
        captured.values = v;
        return qb;
      }),
      orUpdate: jest.fn((cols: string[]) => {
        captured.orUpdateCols = cols;
        return qb;
      }),
      execute: jest.fn(() => {
        insertCalls.push({
          values: captured.values ?? [],
          orUpdateCols: captured.orUpdateCols ?? [],
        });
        return Promise.resolve({});
      }),
    };
    return qb;
  }

  beforeEach(async () => {
    insertCalls = [];
    postMock = jest.fn();
    sleepMock = jest.fn().mockResolvedValue(undefined);
    mangaRepo = { createQueryBuilder: jest.fn(() => makeInsertQb()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogPageIngestService,
        { provide: HttpService, useValue: { post: postMock } },
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
      ],
    }).compile();

    service = module.get<CatalogPageIngestService>(CatalogPageIngestService);
    service.sleep = sleepMock;
  });

  describe('payload MU', () => {
    it('shard global : orderby, perpage 100, NSFW exclus, pas de filtre year', async () => {
      postMock.mockReturnValue(of(muPage(1000, 1, 1)));

      await service.ingestPage(RATING_SHARD, 3);

      const payload = postMock.mock.calls[0][1];
      expect(payload.orderby).toBe('rating');
      expect(payload.perpage).toBe(100);
      expect(payload.page).toBe(3);
      expect(payload.exclude_genre).toContain('Hentai');
      expect(payload.year).toBeUndefined();
      expect(payload.genre).toBeUndefined();
    });

    it('shard annuel : ajoute year', async () => {
      postMock.mockReturnValue(of(muPage(1000, 1, 1)));

      await service.ingestPage(
        {
          jobName: 'catalog:year:2015',
          kind: 'year',
          level: 1,
          orderby: 'rating',
          year: 2015,
        },
        1,
      );

      expect(postMock.mock.calls[0][1].year).toBe(2015);
    });

    it('sous-shard année × genre : ajoute genre sous forme de tableau', async () => {
      postMock.mockReturnValue(of(muPage(1000, 1, 1)));

      await service.ingestPage(
        {
          jobName: 'catalog:year:2024:genre:Action',
          kind: 'year_genre',
          level: 2,
          orderby: 'rating',
          year: 2024,
          genre: 'Action',
        },
        1,
      );

      const payload = postMock.mock.calls[0][1];
      expect(payload.year).toBe(2024);
      // MU attend un tableau même pour un genre unique.
      expect(payload.genre).toEqual(['Action']);
    });

    it('retourne le total_hits annoncé par MU', async () => {
      postMock.mockReturnValue(of(muPage(1000, 100, 4781)));

      await expect(service.ingestPage(RATING_SHARD, 1)).resolves.toBe(4781);
    });
  });

  describe('backoff (non-régression)', () => {
    it('429 persistant : 1 tentative + 4 retries (5/10/20/40 s) puis rejette', async () => {
      postMock.mockImplementation(() => throwError(() => axiosError(429)));

      await expect(service.ingestPage(RATING_SHARD, 1)).rejects.toBeDefined();

      expect(postMock).toHaveBeenCalledTimes(5);
      expect(sleepMock).toHaveBeenCalledWith(5_000);
      expect(sleepMock).toHaveBeenCalledWith(10_000);
      expect(sleepMock).toHaveBeenCalledWith(20_000);
      expect(sleepMock).toHaveBeenCalledWith(40_000);
      // Rien n'a été upserté.
      expect(insertCalls).toHaveLength(0);
    });

    it('reprend le backoff sur 5xx puis réussit', async () => {
      postMock
        .mockImplementationOnce(() => throwError(() => axiosError(503)))
        .mockImplementation(() => of(muPage(1000, 100, 100)));

      await expect(service.ingestPage(RATING_SHARD, 1)).resolves.toBe(100);

      expect(postMock).toHaveBeenCalledTimes(2);
      expect(sleepMock).toHaveBeenCalledWith(5_000);
      expect(insertCalls).toHaveLength(1);
    });

    it('erreur non-retryable (400) : rejette immédiatement sans retry', async () => {
      postMock.mockImplementation(() => throwError(() => axiosError(400)));

      await expect(service.ingestPage(RATING_SHARD, 1)).rejects.toBeDefined();

      expect(postMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).not.toHaveBeenCalled();
    });
  });

  describe('upsert en lots (doctrine null-safe)', () => {
    it('sépare les records avec/sans genres — le 2e lot omet la colonne genres', async () => {
      postMock.mockReturnValue(
        of({
          data: {
            total_hits: 2,
            results: [
              muPage(1000, 1, 2).data.results[0], // avec genres
              muPage(2000, 1, 2, { withGenres: false }).data.results[0], // sans
            ],
          },
        }),
      );

      await service.ingestPage(RATING_SHARD, 1);

      expect(insertCalls).toHaveLength(2);
      const [avecGenres, sansGenres] = insertCalls;
      expect(avecGenres.orUpdateCols).toContain('genres');
      expect(avecGenres.values[0].mu_id).toBe('1000');
      expect(avecGenres.values[0].genres).toEqual(['Action']);
      // Le lot sans genres n'update PAS la colonne genres (jamais écrasée
      // par null) ni total_chapters/completed/associated.
      expect(sansGenres.orUpdateCols).not.toContain('genres');
      expect(sansGenres.values[0].mu_id).toBe('2000');
      for (const call of insertCalls) {
        expect(call.orUpdateCols).not.toContain('total_chapters');
        expect(call.orUpdateCols).not.toContain('completed');
        expect(call.orUpdateCols).not.toContain('associated');
      }
    });

    it('payload entièrement sans genres → un seul lot, sans la colonne genres', async () => {
      postMock.mockReturnValue(of(muPage(1000, 3, 3, { withGenres: false })));

      await service.ingestPage(RATING_SHARD, 1);

      expect(insertCalls).toHaveLength(1);
      expect(insertCalls[0].orUpdateCols).not.toContain('genres');
      expect(insertCalls[0].values).toHaveLength(3);
    });

    it("n'écrase JAMAIS rating/year/covers par null (record search sans bayesian_rating)", async () => {
      // Record MU minimal : pas de year, pas de bayesian_rating, pas d'image.
      postMock.mockReturnValue(
        of({
          data: {
            total_hits: 1,
            results: [
              {
                record: {
                  series_id: 5000,
                  title: 'Sleeper Hit',
                  genres: [{ genre: 'Action' }],
                },
              },
            ],
          },
        }),
      );

      await service.ingestPage(RATING_SHARD, 1);

      expect(insertCalls).toHaveLength(1);
      const cols = insertCalls[0].orUpdateCols;
      // title + genres (non-null) restent écrasables ; rating/year/covers sont
      // OMIS → une note/année/cover déjà hydratée en base n'est pas remise à
      // null par ce record search incomplet.
      expect(cols).toContain('title');
      expect(cols).toContain('genres');
      expect(cols).not.toContain('rating');
      expect(cols).not.toContain('year');
      expect(cols).not.toContain('small_cover_url');
      expect(cols).not.toContain('medium_cover_url');
      // L'INSERT initial garde bien null (colonnes nullable).
      expect(insertCalls[0].values[0].rating).toBeNull();
      expect(insertCalls[0].values[0].year).toBeNull();
    });
  });
});
