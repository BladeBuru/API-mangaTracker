import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GenreSectionService } from './genre-section.service';
import { ScoredEntry } from './scored-entry.interface';
import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { MangasService } from '@/api/mangas/mangas.service';
import { MangaQuickViewDto } from '@/api/mangas/dto/manga-quick-view.dto';

/**
 * Tests du fix 2026-08-25 « by-genre : mêmes titres dans toutes les
 * sections » : dédup par mu_id, exclusivité inter-sections, complément
 * catalogue par section (1 requête max par section), contrat inchangé.
 */
function makeManga(
  mu_id: string,
  genres?: string[],
  overrides: Partial<Manga> = {},
): Manga {
  const manga = new Manga();
  manga.id = Number(mu_id);
  manga.mu_id = mu_id;
  manga.title = `Manga ${mu_id}`;
  manga.year = 2020;
  manga.small_cover_url = `https://cdn/${mu_id}-s.jpg`;
  manga.medium_cover_url = `https://cdn/${mu_id}-m.jpg`;
  manga.rating = 7.5;
  manga.total_chapters = 100;
  manga.genres = genres;
  return Object.assign(manga, overrides);
}

function makeUserManga(mu_id: string, genres?: string[]): UserManga {
  const um = new UserManga();
  um.id = Number(mu_id);
  um.manga = makeManga(mu_id, genres);
  return um;
}

function makeEntry(
  score: number,
  sources: Record<string, number> = { '1000': score },
): ScoredEntry {
  return { score, sources: new Map(Object.entries(sources)) };
}

describe('GenreSectionService', () => {
  let service: GenreSectionService;
  let mangaRepo: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let mangasService: { getCommunityRatings: jest.Mock };
  /** Mangas servis par `mangaRepo.find` (pool + titres sources). */
  let mangasById: Map<string, Manga>;

  /**
   * Mock du QueryBuilder catalogue : chaque appel à `createQueryBuilder`
   * consomme le prochain résultat de `queue` (Manga[] ou Error). Queue
   * épuisée → []. Retourne la liste des QB créés pour inspection.
   */
  function mockCatalogQb(queue: Array<Manga[] | Error> = []) {
    const created: Array<Record<string, jest.Mock>> = [];
    let call = 0;
    mangaRepo.createQueryBuilder.mockImplementation(() => {
      const result = call < queue.length ? queue[call] : [];
      call += 1;
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany:
          result instanceof Error
            ? jest.fn().mockRejectedValue(result)
            : jest.fn().mockResolvedValue(result),
      };
      created.push(qb);
      return qb;
    });
    return created;
  }

  function registerMangas(...mangas: Manga[]) {
    for (const manga of mangas) mangasById.set(manga.mu_id, manga);
  }

  beforeEach(async () => {
    mangasById = new Map();
    mangaRepo = {
      find: jest.fn().mockImplementation(({ where }) => {
        const ids = (where as any).mu_id._value as string[];
        return Promise.resolve(
          ids
            .map((id) => mangasById.get(id))
            .filter((m): m is Manga => Boolean(m)),
        );
      }),
      createQueryBuilder: jest.fn(),
    };
    mangasService = {
      getCommunityRatings: jest.fn().mockResolvedValue(new Map()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GenreSectionService,
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
        { provide: MangasService, useValue: mangasService },
      ],
    }).compile();

    service = module.get<GenreSectionService>(GenreSectionService);
  });

  it('retourne {} sans requête si le pool est vide', async () => {
    const result = await service.buildSections(new Map(), [], 5, 10, new Set());
    expect(result).toEqual({});
    expect(mangaRepo.find).not.toHaveBeenCalled();
  });

  it('dédoublonne par mu_id malgré des genres dupliqués (« Action », « Action  »)', async () => {
    registerMangas(makeManga('2000', ['Action', 'Action ', ' Action']));
    mockCatalogQb();

    const result = await service.buildSections(
      new Map([['2000', makeEntry(10)]]),
      [makeUserManga('1000', ['Action'])],
      5,
      10,
      new Set(['1000']),
    );

    // Une seule section Action (les variantes trimées fusionnent) et le
    // manga n'y apparaît qu'une fois — avant le fix il y figurait en triple.
    expect(Object.keys(result)).toEqual(['Action']);
    expect(result['Action'].map((d) => d.muId)).toEqual([2000]);
  });

  it('exclusivité inter-sections : un manga multi-genres ne sort que dans son genre le mieux classé', async () => {
    registerMangas(
      makeManga('2000', ['Action', 'Romance']),
      makeManga('2001', ['Romance']),
    );
    mockCatalogQb();

    const result = await service.buildSections(
      new Map([
        ['2000', makeEntry(10)],
        ['2001', makeEntry(8)],
      ]),
      // Biblio : Action (2 occurrences) mieux classé que Romance (1).
      [
        makeUserManga('1000', ['Action']),
        makeUserManga('1001', ['Action']),
        makeUserManga('1002', ['Romance']),
      ],
      5,
      10,
      new Set(['1000', '1001', '1002']),
    );

    expect(result['Action'].map((d) => d.muId)).toEqual([2000]);
    expect(result['Romance'].map((d) => d.muId)).toEqual([2001]);
    // 2000 (Action + Romance) ne doit PAS être dupliqué dans Romance.
    const all = Object.values(result).flatMap((l) => l.map((d) => d.muId));
    expect(new Set(all).size).toBe(all.length);
  });

  it('bascule dans son genre suivant quand la meilleure section est pleine (pas de perte)', async () => {
    registerMangas(
      makeManga('2000', ['Action']),
      makeManga('2001', ['Action', 'Romance']),
    );
    mockCatalogQb();

    const result = await service.buildSections(
      new Map([
        ['2000', makeEntry(10)],
        ['2001', makeEntry(9)],
      ]),
      [
        makeUserManga('1000', ['Action']),
        makeUserManga('1001', ['Action']),
        makeUserManga('1002', ['Romance']),
      ],
      5,
      1, // perGenre = 1 → Action pleine avec 2000
      new Set(['1000', '1001', '1002']),
    );

    expect(result['Action'].map((d) => d.muId)).toEqual([2000]);
    expect(result['Romance'].map((d) => d.muId)).toEqual([2001]);
    // Sections pleines → aucun complément catalogue requis.
    expect(mangaRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('complète une section déficitaire via le catalogue (1 requête, exclusions biblio + affichés)', async () => {
    registerMangas(makeManga('2000', ['Action']));
    const qbs = mockCatalogQb([
      [
        makeManga('9000', ['Action'], { rating: 8.2 }),
        makeManga('9001', ['Action'], { rating: 7.6 }),
      ],
    ]);

    const result = await service.buildSections(
      new Map([['2000', makeEntry(10)]]),
      [makeUserManga('1000', ['Action'])],
      5,
      3, // 1 titre pool → déficit de 2
      new Set(['1000']),
    );

    // Pool d'abord (score desc), compléments ensuite (rating desc).
    expect(result['Action'].map((d) => d.muId)).toEqual([2000, 9000, 9001]);
    // Une seule requête catalogue pour la seule section déficitaire.
    expect(mangaRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    const qb = qbs[0];
    // Exclusions : biblio (1000) + titres déjà affichés (2000).
    const excludeCall = qb.andWhere.mock.calls.find(([sql]) =>
      (sql as string).includes('excludeMuIds'),
    );
    expect(excludeCall).toBeDefined();
    const excluded = (excludeCall![1] as { excludeMuIds: string[] })
      .excludeMuIds;
    expect(excluded).toContain('1000');
    expect(excluded).toContain('2000');
    // Rating floor 7.0 (pattern CatalogCandidateService).
    const ratingCall = qb.andWhere.mock.calls.find(([sql]) =>
      (sql as string).includes('ratingFloor'),
    );
    expect(ratingCall![1]).toEqual({ ratingFloor: 7.0 });
    // NSFW exclus au niveau de la requête.
    const nsfwCall = qb.andWhere.mock.calls.find(([sql]) =>
      (sql as string).includes('nsfwGenres'),
    );
    expect(nsfwCall).toBeDefined();
    // limit = déficit exact (pas de sur-fetch).
    expect(qb.limit).toHaveBeenCalledWith(2);
    // Les compléments catalogue n'ont pas de recommendedBecauseOf.
    const filler = result['Action'].find((d) => d.muId === 9000);
    expect(filler!.recommendedBecauseOf).toBeUndefined();
  });

  it('émet au plus une requête catalogue par section déficitaire et exclut les compléments précédents', async () => {
    registerMangas(
      makeManga('2000', ['Action']),
      makeManga('2001', ['Romance']),
    );
    const qbs = mockCatalogQb([
      [makeManga('9000', ['Action', 'Romance'], { rating: 8.0 })],
      [makeManga('9100', ['Romance'], { rating: 7.8 })],
    ]);

    const result = await service.buildSections(
      new Map([
        ['2000', makeEntry(10)],
        ['2001', makeEntry(8)],
      ]),
      [
        makeUserManga('1000', ['Action']),
        makeUserManga('1001', ['Action']),
        makeUserManga('1002', ['Romance']),
      ],
      5,
      2, // chaque section a 1 titre pool → déficit de 1 chacune
      new Set(['1000', '1001', '1002']),
    );

    // 2 sections déficitaires → exactement 2 requêtes (pas de N+1).
    expect(mangaRepo.createQueryBuilder).toHaveBeenCalledTimes(2);
    expect(result['Action'].map((d) => d.muId)).toEqual([2000, 9000]);
    expect(result['Romance'].map((d) => d.muId)).toEqual([2001, 9100]);
    // La requête Romance exclut le complément 9000 déjà affiché dans Action.
    const romanceExclude = qbs[1].andWhere.mock.calls.find(([sql]) =>
      (sql as string).includes('excludeMuIds'),
    );
    const excluded = (romanceExclude![1] as { excludeMuIds: string[] })
      .excludeMuIds;
    expect(excluded).toContain('9000');
    // Aucun doublon inter-sections, compléments inclus.
    const all = Object.values(result).flatMap((l) => l.map((d) => d.muId));
    expect(new Set(all).size).toBe(all.length);
  });

  it('sections classées par genres favoris de la biblio (pas par représentation du pool)', async () => {
    registerMangas(
      makeManga('2000', ['Action']),
      makeManga('2001', ['Action']),
      makeManga('2002', ['Action']),
      makeManga('2003', ['Romance']),
    );
    mockCatalogQb();

    const result = await service.buildSections(
      new Map([
        ['2000', makeEntry(10)],
        ['2001', makeEntry(9)],
        ['2002', makeEntry(8)],
        ['2003', makeEntry(7)],
      ]),
      // Biblio : Romance (2) devant Action (1) — même si le pool est
      // majoritairement Action.
      [
        makeUserManga('1000', ['Romance']),
        makeUserManga('1001', ['Romance']),
        makeUserManga('1002', ['Action']),
      ],
      5,
      10,
      new Set(['1000', '1001', '1002']),
    );

    expect(Object.keys(result)).toEqual(['Romance', 'Action']);
    expect(result['Romance'].map((d) => d.muId)).toEqual([2003]);
    expect(result['Action'].map((d) => d.muId)).toEqual([2000, 2001, 2002]);
  });

  it('fallback pool : biblio sans genres (stubs) → genres issus du pool', async () => {
    registerMangas(
      makeManga('2000', ['Action']),
      makeManga('2001', ['Action']),
      makeManga('2002', ['Romance']),
    );
    mockCatalogQb();

    const result = await service.buildSections(
      new Map([
        ['2000', makeEntry(10)],
        ['2001', makeEntry(9)],
        ['2002', makeEntry(8)],
      ]),
      [makeUserManga('1000', undefined)], // stub sans genres
      5,
      10,
      new Set(['1000']),
    );

    // Action (2 candidats pool) avant Romance (1).
    expect(Object.keys(result)).toEqual(['Action', 'Romance']);
  });

  it('tolère une panne catalogue et omet les sections restées vides', async () => {
    registerMangas(makeManga('2000', ['Action']));
    mockCatalogQb([new Error('catalogue down'), new Error('catalogue down')]);

    const result = await service.buildSections(
      new Map([['2000', makeEntry(10)]]),
      [makeUserManga('1000', ['Action']), makeUserManga('1001', ['Isekai'])],
      5,
      3,
      new Set(['1000', '1001']),
    );

    // Action servie avec son titre pool malgré l'échec du complément ;
    // Isekai (aucun titre) est omise de la réponse.
    expect(Object.keys(result)).toEqual(['Action']);
    expect(result['Action'].map((d) => d.muId)).toEqual([2000]);
  });

  it('respecte le contrat : Record<genre, MangaQuickViewDto[]> enrichi (sources + notes communautaires)', async () => {
    registerMangas(
      makeManga('2000', ['Action']),
      makeManga('1000', undefined, { title: 'One Piece' }),
    );
    mockCatalogQb([[makeManga('9000', ['Action'], { rating: 8.0 })]]);
    mangasService.getCommunityRatings.mockResolvedValue(
      new Map([
        [
          '2000',
          {
            communityRating: 8.4,
            communityRatingCount: 5,
            aggregatedRating: 7.9,
          },
        ],
        [
          '9000',
          {
            communityRating: null,
            communityRatingCount: 0,
            aggregatedRating: 8.0,
          },
        ],
      ]),
    );

    const result = await service.buildSections(
      new Map([['2000', makeEntry(10, { '1000': 10 })]]),
      [makeUserManga('1000', ['Action'])],
      5,
      2,
      new Set(['1000']),
    );

    const dto = result['Action'][0];
    expect(dto).toBeInstanceOf(MangaQuickViewDto);
    expect(typeof dto.muId).toBe('number');
    expect(dto.recommendedBecauseOf).toEqual(['One Piece']);
    expect(dto.communityRating).toBe(8.4);
    expect(dto.aggregatedRating).toBe(7.9);
    const filler = result['Action'][1];
    expect(filler.muId).toBe(9000);
    expect(filler.communityRating).toBeUndefined(); // null → non exposé
    expect(filler.aggregatedRating).toBe(8.0);
    // L'enrichissement couvre pool ET compléments en un seul appel.
    expect(mangasService.getCommunityRatings).toHaveBeenCalledTimes(1);
    const [idsArg] = mangasService.getCommunityRatings.mock.calls[0];
    expect(idsArg).toEqual(expect.arrayContaining(['2000', '9000']));
  });
});
