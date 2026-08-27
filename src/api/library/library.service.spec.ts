import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { LibraryService } from './library.service';
import { UserService } from '@/api/user/user.service';
import { MangasService } from '@/api/mangas/mangas.service';
import { UpdateMangaService } from '@/api/mangas/update-manga.service';
import { RecoCacheService } from '@/api/recommendations/reco-cache.service';
import { ChapterLogService } from './chapter-log.service';
import { ChapterReportService } from './chapter-report.service';
import { ChapterException } from './exceptions/chapter.exception';
import { ReadingStatus } from './reading-status.enum';
import User from '@/api/user/user.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';

/** Query builder chainable générique. */
const createQb = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['update', 'set', 'setParameter', 'where', 'andWhere']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.execute = jest.fn().mockResolvedValue({});
  return qb;
};

describe('LibraryService — updateChapter (chantiers A & B)', () => {
  let service: LibraryService;
  let userRepo: { findOne: jest.Mock };
  let mangaRepo: { save: jest.Mock; createQueryBuilder: jest.Mock };
  let userMangaRepo: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let mangasService: {
    returnMangaIfExist: jest.Mock;
    getMangaDetails: jest.Mock;
  };
  let updateMangaService: {
    getMangasIds: jest.Mock;
    checkIfMangaArrayInfoIsOutdated: jest.Mock;
  };
  let recoCache: { invalidateUser: jest.Mock };
  let chapterLogService: { recordBackfill: jest.Mock };
  let chapterReportService: {
    getEffectiveTotal: jest.Mock;
    getUserReportsByMangaIds: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };
  let managerMock: { createQueryBuilder: jest.Mock; getRepository: jest.Mock };
  let managerQb: Record<string, jest.Mock>;
  let repoQb: Record<string, jest.Mock>;

  /** Manga frais en BDD (updated_at récent → pas de refresh MU). */
  const freshManga = (total: number, completed = false) => ({
    mu_id: '42',
    total_chapters: total,
    completed,
    updated_at: new Date(),
  });

  /** Entrée bibliothèque du user pour le manga 42. */
  const libraryEntry = (oldRead: number, total = 100) => ({
    manga: {
      mu_id: '42',
      title: 'Test Manga',
      year: 2020,
      medium_cover_url: 'cover.jpg',
      rating: 7,
      total_chapters: total,
      completed: false,
      associated: [],
    },
    user_read_chapters: oldRead,
    readingStatus: ReadingStatus.Reading,
    user_rating: 0,
    custom_link: null,
    lastUpdated: new Date(),
  });

  beforeEach(async () => {
    userRepo = { findOne: jest.fn() };
    mangaRepo = { save: jest.fn(), createQueryBuilder: jest.fn() };
    repoQb = createQb();
    userMangaRepo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(repoQb),
    };
    mangasService = {
      returnMangaIfExist: jest.fn(),
      getMangaDetails: jest.fn(),
    };
    updateMangaService = {
      getMangasIds: jest.fn().mockResolvedValue([42]),
      checkIfMangaArrayInfoIsOutdated: jest.fn().mockResolvedValue([]),
    };
    recoCache = { invalidateUser: jest.fn() };
    chapterLogService = { recordBackfill: jest.fn().mockResolvedValue(0) };
    chapterReportService = {
      getEffectiveTotal: jest.fn(),
      getUserReportsByMangaIds: jest.fn().mockResolvedValue(new Map()),
    };
    managerQb = createQb();
    managerMock = {
      createQueryBuilder: jest.fn().mockReturnValue(managerQb),
      getRepository: jest.fn(),
    };
    dataSource = {
      transaction: jest.fn(async (cb) => cb(managerMock)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LibraryService,
        { provide: UserService, useValue: {} },
        { provide: MangasService, useValue: mangasService },
        { provide: UpdateMangaService, useValue: updateMangaService },
        { provide: RecoCacheService, useValue: recoCache },
        { provide: ChapterLogService, useValue: chapterLogService },
        { provide: ChapterReportService, useValue: chapterReportService },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
        { provide: getRepositoryToken(UserManga), useValue: userMangaRepo },
      ],
    }).compile();

    service = module.get<LibraryService>(LibraryService);
  });

  const givenUserWithEntry = (oldRead: number, total = 100) => {
    userRepo.findOne.mockResolvedValue({
      id: 1,
      user_mangas: [libraryEntry(oldRead, total)],
    });
  };

  it('should throw a 406 ChapterException above the EFFECTIVE total (official + report)', async () => {
    givenUserWithEntry(90);
    mangasService.returnMangaIfExist.mockResolvedValue(freshManga(100));
    chapterReportService.getEffectiveTotal.mockResolvedValue(107);

    await expect(service.updateChapter(1, 42, 108)).rejects.toThrow(
      ChapterException,
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(repoQb.execute).not.toHaveBeenCalled();
  });

  it('should accept a progression between the official total and the reported one', async () => {
    givenUserWithEntry(90);
    mangasService.returnMangaIfExist.mockResolvedValue(freshManga(100));
    chapterReportService.getEffectiveTotal.mockResolvedValue(107);

    await expect(service.updateChapter(1, 42, 105)).resolves.toBe(true);
    // 105 < 107 (total effectif) → toujours en cours de lecture.
    expect(managerQb.set.mock.calls[0][0].readingStatus).toBe(
      ReadingStatus.Reading,
    );
    expect(managerQb.set.mock.calls[0][0].user_read_chapters).toBe(105);
  });

  it('should stay Reading while below the effective total, even above the official one', async () => {
    givenUserWithEntry(100);
    mangasService.returnMangaIfExist.mockResolvedValue(freshManga(100, true));
    chapterReportService.getEffectiveTotal.mockResolvedValue(107);

    await service.updateChapter(1, 42, 101);

    expect(managerQb.set.mock.calls[0][0].readingStatus).toBe(
      ReadingStatus.Reading,
    );
  });

  it('should switch to CaughtUp at the effective total when the manga is not completed', async () => {
    givenUserWithEntry(90);
    mangasService.returnMangaIfExist.mockResolvedValue(freshManga(100, false));
    chapterReportService.getEffectiveTotal.mockResolvedValue(107);

    await service.updateChapter(1, 42, 107);

    expect(managerQb.set.mock.calls[0][0].readingStatus).toBe(
      ReadingStatus.CaughtUp,
    );
  });

  it('should switch to Completed at the effective total when the manga is completed', async () => {
    givenUserWithEntry(90);
    mangasService.returnMangaIfExist.mockResolvedValue(freshManga(100, true));
    chapterReportService.getEffectiveTotal.mockResolvedValue(107);

    await service.updateChapter(1, 42, 107);

    expect(managerQb.set.mock.calls[0][0].readingStatus).toBe(
      ReadingStatus.Completed,
    );
  });

  it('should backfill the chapter log from oldRead+1 to newRead inside the transaction', async () => {
    givenUserWithEntry(90);
    mangasService.returnMangaIfExist.mockResolvedValue(freshManga(100));
    chapterReportService.getEffectiveTotal.mockResolvedValue(100);

    await service.updateChapter(1, 42, 95);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(chapterLogService.recordBackfill).toHaveBeenCalledTimes(1);
    expect(chapterLogService.recordBackfill).toHaveBeenCalledWith(
      1,
      42,
      90,
      95,
      managerMock,
    );
  });

  it('should NOT write any chapter log on a decrement (additive journal, B-4)', async () => {
    givenUserWithEntry(90);
    mangasService.returnMangaIfExist.mockResolvedValue(freshManga(100));
    chapterReportService.getEffectiveTotal.mockResolvedValue(100);

    await expect(service.updateChapter(1, 42, 80)).resolves.toBe(true);

    expect(chapterLogService.recordBackfill).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
    // Le pointeur est quand même mis à jour (hors transaction).
    expect(repoQb.set.mock.calls[0][0].user_read_chapters).toBe(80);
    expect(repoQb.execute).toHaveBeenCalled();
  });

  it('should fall back to sequential writes when the transaction fails (pointer first)', async () => {
    givenUserWithEntry(90);
    mangasService.returnMangaIfExist.mockResolvedValue(freshManga(100));
    chapterReportService.getEffectiveTotal.mockResolvedValue(100);
    dataSource.transaction.mockRejectedValue(new Error('tx unavailable'));

    await expect(service.updateChapter(1, 42, 95)).resolves.toBe(true);

    // Fallback : UPDATE du pointeur via le repository (hors transaction)…
    expect(repoQb.set.mock.calls[0][0].user_read_chapters).toBe(95);
    expect(repoQb.execute).toHaveBeenCalled();
    // …puis backfill best-effort SANS manager.
    expect(chapterLogService.recordBackfill).toHaveBeenCalledWith(
      1,
      42,
      90,
      95,
    );
  });
});

describe('LibraryService — checkManga (A-5 GREATEST)', () => {
  let service: LibraryService;
  let mangaRepo: { save: jest.Mock; createQueryBuilder: jest.Mock };
  let mangasService: {
    returnMangaIfExist: jest.Mock;
    getMangaDetails: jest.Mock;
  };
  let updateQb: Record<string, jest.Mock>;

  beforeEach(async () => {
    updateQb = createQb();
    mangaRepo = {
      save: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(updateQb),
    };
    mangasService = {
      returnMangaIfExist: jest.fn(),
      getMangaDetails: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LibraryService,
        { provide: UserService, useValue: {} },
        { provide: MangasService, useValue: mangasService },
        { provide: UpdateMangaService, useValue: {} },
        { provide: RecoCacheService, useValue: { invalidateUser: jest.fn() } },
        { provide: ChapterLogService, useValue: {} },
        { provide: ChapterReportService, useValue: {} },
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } },
        { provide: getRepositoryToken(User), useValue: {} },
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
        { provide: getRepositoryToken(UserManga), useValue: {} },
      ],
    }).compile();

    service = module.get<LibraryService>(LibraryService);
  });

  it('should refresh a stale manga with GREATEST on total_chapters (never regress)', async () => {
    const staleManga = {
      mu_id: '42',
      total_chapters: 100,
      completed: true,
      // > 6h → refresh MU déclenché.
      updated_at: new Date(Date.now() - 7 * 3600 * 1000),
    };
    mangasService.returnMangaIfExist.mockResolvedValue(staleManga);
    // MU annonce un total PLUS BAS (120 → régression regex) : la valeur est
    // quand même passée en GREATEST, donc jamais de régression en BDD.
    mangasService.getMangaDetails.mockResolvedValue({
      muId: 42,
      title: 'Test Manga',
      year: 2020,
      smallCoverUrl: 's.jpg',
      mediumCoverUrl: 'm.jpg',
      rating: 7,
      totalChapters: 120,
      completed: true,
      associated: [],
    });

    await service.checkManga(42);

    const setArg = updateQb.set.mock.calls[0][0];
    expect(typeof setArg.total_chapters).toBe('function');
    expect(setArg.total_chapters()).toBe('GREATEST(total_chapters, :newTotal)');
    expect(updateQb.setParameter).toHaveBeenCalledWith('newTotal', 120);
    // completed reste écrasé par la valeur MU (design A-5).
    expect(setArg.completed).toBe(true);
  });
});

describe('LibraryService — getMangas (exposition des reports)', () => {
  let service: LibraryService;
  let userRepo: { findOne: jest.Mock };
  let chapterReportService: { getUserReportsByMangaIds: jest.Mock };

  beforeEach(async () => {
    userRepo = { findOne: jest.fn() };
    chapterReportService = {
      getUserReportsByMangaIds: jest.fn().mockResolvedValue(new Map()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LibraryService,
        { provide: UserService, useValue: {} },
        { provide: MangasService, useValue: {} },
        {
          provide: UpdateMangaService,
          useValue: {
            getMangasIds: jest.fn().mockResolvedValue([42]),
            checkIfMangaArrayInfoIsOutdated: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: RecoCacheService, useValue: { invalidateUser: jest.fn() } },
        { provide: ChapterLogService, useValue: {} },
        { provide: ChapterReportService, useValue: chapterReportService },
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(Manga), useValue: {} },
        { provide: getRepositoryToken(UserManga), useValue: {} },
      ],
    }).compile();

    service = module.get<LibraryService>(LibraryService);
  });

  it('should expose the effective total and userReportedTotalChapters from the user report', async () => {
    userRepo.findOne.mockResolvedValue({
      id: 1,
      user_mangas: [
        {
          manga: {
            mu_id: '42',
            title: 'Test Manga',
            year: 2020,
            medium_cover_url: 'cover.jpg',
            rating: 7,
            total_chapters: 100,
            associated: [],
          },
          user_read_chapters: 90,
          readingStatus: ReadingStatus.Reading,
          user_rating: 0,
          custom_link: null,
          lastUpdated: new Date(),
        },
      ],
    });
    chapterReportService.getUserReportsByMangaIds.mockResolvedValue(
      new Map([['42', 120]]),
    );

    const result = await service.getMangas(1);

    expect(chapterReportService.getUserReportsByMangaIds).toHaveBeenCalledWith(
      1,
      [42],
    );
    expect(result).toHaveLength(1);
    expect(result[0].totalChapters).toBe(120);
    expect(result[0].userReportedTotalChapters).toBe(120);
    expect(result[0].readChapters).toBe(90);
  });
});
