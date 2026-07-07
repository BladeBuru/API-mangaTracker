import { Test, TestingModule } from '@nestjs/testing';
import { MangasService } from './mangas.service';
import { HttpModule, HttpService } from '@nestjs/axios';
import { HelperService } from './helper.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { of } from 'rxjs';
import { Manga } from './manga.entity';
import { MangaRecommendation } from './manga-recommendation.entity';
import { UserManga } from './user-manga.entity';
import { MU_TRENDS_URL, NSFW_GENRES } from './constants';

const mockRepo = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
  createQueryBuilder: jest.fn(() => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    orUpdate: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({}),
  })),
});

describe('MangasService', () => {
  let service: MangasService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MangasService,
        HelperService,
        { provide: getRepositoryToken(Manga), useValue: mockRepo() },
        {
          provide: getRepositoryToken(MangaRecommendation),
          useValue: mockRepo(),
        },
        { provide: getRepositoryToken(UserManga), useValue: mockRepo() },
      ],
      imports: [HttpModule],
    }).compile();

    service = module.get<MangasService>(MangasService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

describe('MangasService — searchManga', () => {
  let service: MangasService;
  let postMock: jest.Mock;

  const muRecord = (
    seriesId: number,
    title: string,
    rating: number,
    hitTitle: string | null = null,
  ) => ({
    record: {
      series_id: seriesId,
      title,
      year: '2025',
      bayesian_rating: rating,
      image: { url: { original: `https://cdn.example/${seriesId}.jpg` } },
      associated: [],
    },
    hit_title: hitTitle,
  });

  // MU renvoie en écho la page servie et le per_page EFFECTIF (il coerce
  // silencieusement les valeurs non supportées, ex. perpage 20 → 25).
  const muResponse = (
    results: unknown[],
    totalHits: number,
    { page = 1, perPage = 25 }: { page?: number; perPage?: number } = {},
  ) =>
    of({
      data: { total_hits: totalHits, page, per_page: perPage, results },
    });

  beforeEach(async () => {
    postMock = jest.fn().mockReturnValue(muResponse([], 0));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MangasService,
        { provide: HttpService, useValue: { post: postMock } },
        { provide: HelperService, useValue: {} },
        { provide: getRepositoryToken(Manga), useValue: mockRepo() },
        {
          provide: getRepositoryToken(MangaRecommendation),
          useValue: mockRepo(),
        },
        { provide: getRepositoryToken(UserManga), useValue: mockRepo() },
      ],
    }).compile();

    service = module.get<MangasService>(MangasService);
  });

  it('should query MU with relevance ranking (no orderby) and stype title', async () => {
    await service.searchManga('Shadow System');

    expect(postMock).toHaveBeenCalledWith(MU_TRENDS_URL, {
      search: 'Shadow System',
      stype: 'title',
      page: 1,
      perpage: 20,
      exclude_genre: NSFW_GENRES,
    });
    // Le tri par pertinence de MU est son défaut : tout orderby explicite
    // (rating/title) écrase la pertinence et fait disparaître les titres
    // de niche du top — c'était la cause du bug « Shadow System ».
    const payload = postMock.mock.calls[0][1];
    expect(payload).not.toHaveProperty('orderby');
  });

  it('should map limit/page to MU perpage/page', async () => {
    await service.searchManga('Naruto', 50, 3);

    const payload = postMock.mock.calls[0][1];
    expect(payload.perpage).toBe(50);
    expect(payload.page).toBe(3);
  });

  it('should clamp perpage to the MU maximum (100)', async () => {
    // MU retombe silencieusement à 25 au-delà de 100 → on borne nous-mêmes.
    await service.searchManga('Naruto', 500, 1);

    expect(postMock.mock.calls[0][1].perpage).toBe(100);
  });

  it('should preserve the MU relevance order (no local re-sort)', async () => {
    const nicheExactMatch = muRecord(
      27261496420,
      'Shadow System: Harnessing',
      5.65,
    );
    const popularFuzzyMatch = muRecord(111, 'Shadow House', 8.9);
    postMock.mockReturnValue(
      muResponse([nicheExactMatch, popularFuzzyMatch], 2),
    );

    const response = await service.searchManga('Shadow System');

    expect(response.results.map((r) => r.muId)).toEqual([27261496420, 111]);
  });

  it('should return a pagination envelope with totalHits and hasMore', async () => {
    postMock.mockReturnValue(
      muResponse([muRecord(1, 'Naruto', 7.69)], 2486, { page: 2, perPage: 20 }),
    );

    const response = await service.searchManga('Naruto', 20, 2);

    expect(response.totalHits).toBe(2486);
    expect(response.page).toBe(2);
    expect(response.perPage).toBe(20);
    expect(response.hasMore).toBe(true);
  });

  it('should build the envelope from the MU echo when perpage is coerced', async () => {
    // MU coerce perpage=20 → 25 : l'enveloppe doit refléter le pas RÉEL de
    // pagination, sinon hasMore désynchronise et produit des pages vides.
    postMock.mockReturnValue(
      muResponse(
        Array.from({ length: 25 }, (_, i) => muRecord(i + 1, `Title ${i}`, 5)),
        316,
        { page: 1, perPage: 25 },
      ),
    );

    const response = await service.searchManga('Naruto', 20, 1);

    expect(response.perPage).toBe(25);
    expect(response.page).toBe(1);
    expect(response.hasMore).toBe(true); // 1 * 25 < 316
  });

  it('should report hasMore=false on the last page', async () => {
    postMock.mockReturnValue(
      muResponse([muRecord(1, 'Naruto', 7.69)], 35, { page: 2, perPage: 20 }),
    );

    const response = await service.searchManga('Naruto', 20, 2);

    expect(response.hasMore).toBe(false);
  });

  it('should report hasMore=false when MU returns an empty page', async () => {
    // Même si totalHits prétend qu'il reste des pages (désync MU), une page
    // vide doit couper la pagination côté client.
    postMock.mockReturnValue(muResponse([], 500, { page: 14, perPage: 25 }));

    const response = await service.searchManga('Naruto', 25, 14);

    expect(response.results).toEqual([]);
    expect(response.hasMore).toBe(false);
  });

  it('should return an empty envelope when MU has no match', async () => {
    postMock.mockReturnValue(muResponse([], 0));

    const response = await service.searchManga('zzz-introuvable');

    expect(response.results).toEqual([]);
    expect(response.totalHits).toBe(0);
    expect(response.hasMore).toBe(false);
  });
});
