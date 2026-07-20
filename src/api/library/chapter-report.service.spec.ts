import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ChapterReportService,
  MAX_REPORT_DELTA,
  MIN_REPORTERS,
} from './chapter-report.service';
import { MangaChapterReport } from './manga-chapter-report.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';

/** Query builder chainable générique — chaque appel retourne le même mock. */
const createQb = () => {
  const qb: Record<string, jest.Mock> = {};
  const chainMethods = [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'insert',
    'into',
    'values',
    'orUpdate',
    'update',
    'set',
    'setParameter',
    'delete',
    'from',
    'orderBy',
  ];
  for (const method of chainMethods) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.execute = jest.fn().mockResolvedValue({});
  qb.getRawOne = jest.fn().mockResolvedValue(undefined);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  return qb;
};

describe('ChapterReportService', () => {
  let service: ChapterReportService;
  let reportRepo: {
    findOne: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let mangaRepo: { findOneBy: jest.Mock; createQueryBuilder: jest.Mock };
  let userMangaRepo: { findOne: jest.Mock };

  const mangaWithTotal = (total: number) => ({
    mu_id: '42',
    total_chapters: total,
    completed: false,
  });

  beforeEach(async () => {
    reportRepo = {
      findOne: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
      createQueryBuilder: jest.fn(),
    };
    mangaRepo = { findOneBy: jest.fn(), createQueryBuilder: jest.fn() };
    userMangaRepo = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChapterReportService,
        {
          provide: getRepositoryToken(MangaChapterReport),
          useValue: reportRepo,
        },
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
        { provide: getRepositoryToken(UserManga), useValue: userMangaRepo },
      ],
    }).compile();

    service = module.get<ChapterReportService>(ChapterReportService);
  });

  describe('reportMoreChapters — validations', () => {
    it('should throw 404 when the manga is not in the user library (anti-abuse gate)', async () => {
      userMangaRepo.findOne.mockResolvedValue(null);

      await expect(service.reportMoreChapters(1, 42, 95)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw 400 when reportedTotal is not above the known total', async () => {
      userMangaRepo.findOne.mockResolvedValue({ id: 10 });
      mangaRepo.findOneBy.mockResolvedValue(mangaWithTotal(90));

      await expect(service.reportMoreChapters(1, 42, 90)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw 400 when reportedTotal exceeds total + MAX_REPORT_DELTA', async () => {
      userMangaRepo.findOne.mockResolvedValue({ id: 10 });
      mangaRepo.findOneBy.mockResolvedValue(mangaWithTotal(90));

      await expect(
        service.reportMoreChapters(1, 42, 90 + MAX_REPORT_DELTA + 1),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('reportMoreChapters — upsert', () => {
    let qb: Record<string, jest.Mock>;

    beforeEach(() => {
      userMangaRepo.findOne.mockResolvedValue({ id: 10 });
      mangaRepo.findOneBy.mockResolvedValue(mangaWithTotal(90));
      qb = createQb();
      reportRepo.createQueryBuilder.mockReturnValue(qb);
      jest.spyOn(service, 'consolidate').mockResolvedValue(false);
    });

    it('should upsert on (user_id, manga_id) so a second report from the same user overwrites', async () => {
      await service.reportMoreChapters(1, 42, 95);
      await service.reportMoreChapters(1, 42, 97);

      expect(qb.orUpdate).toHaveBeenCalledTimes(2);
      expect(qb.orUpdate).toHaveBeenCalledWith(
        ['reported_total', 'updated_at'],
        ['user_id', 'manga_id'],
      );
      expect(qb.values.mock.calls[0][0].reported_total).toBe(95);
      expect(qb.values.mock.calls[1][0].reported_total).toBe(97);
    });

    it('should return the effective total (max of official and reported)', async () => {
      const result = await service.reportMoreChapters(1, 42, 95);

      expect(result).toEqual({
        reportedTotal: 95,
        effectiveTotalChapters: 95,
        consolidated: false,
      });
    });

    it('should re-read the official total after a consolidation', async () => {
      (service.consolidate as jest.Mock).mockResolvedValue(true);
      mangaRepo.findOneBy
        .mockResolvedValueOnce(mangaWithTotal(90))
        .mockResolvedValueOnce(mangaWithTotal(95));

      const result = await service.reportMoreChapters(1, 42, 95);

      expect(result).toEqual({
        reportedTotal: 95,
        effectiveTotalChapters: 95,
        consolidated: true,
      });
    });
  });

  describe('consolidate', () => {
    it('should do nothing with a single reporter (< MIN_REPORTERS)', async () => {
      mangaRepo.findOneBy.mockResolvedValue(mangaWithTotal(90));
      const selectQb = createQb();
      selectQb.getRawOne.mockResolvedValue({
        reporters: '1',
        min_reported: '95',
      });
      reportRepo.createQueryBuilder.mockReturnValue(selectQb);

      const consolidated = await service.consolidate(42);

      expect(MIN_REPORTERS).toBe(2);
      expect(consolidated).toBe(false);
      expect(mangaRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should bump the official total to the MIN of concordant reports (2 users, 95/97)', async () => {
      mangaRepo.findOneBy.mockResolvedValue(mangaWithTotal(90));
      const selectQb = createQb();
      selectQb.getRawOne.mockResolvedValue({
        reporters: '2',
        min_reported: '95',
      });
      const deleteQb = createQb();
      reportRepo.createQueryBuilder
        .mockReturnValueOnce(selectQb)
        .mockReturnValueOnce(deleteQb);
      const updateQb = createQb();
      mangaRepo.createQueryBuilder.mockReturnValue(updateQb);

      const consolidated = await service.consolidate(42);

      expect(consolidated).toBe(true);
      // newTotal = max(90 existant, 95 = MIN des reports concordants) = 95,
      // écrit en GREATEST (monotone croissant, pas de régression).
      expect(updateQb.setParameter).toHaveBeenCalledWith('newTotal', 95);
      const setArg = updateQb.set.mock.calls[0][0];
      expect(typeof setArg.total_chapters).toBe('function');
      expect(setArg.total_chapters()).toBe(
        'GREATEST(total_chapters, :newTotal)',
      );
      // completed n'est PAS touché par la consolidation.
      expect(setArg.completed).toBeUndefined();
    });

    it('should purge the reports covered by the new total (≤ newTotal)', async () => {
      mangaRepo.findOneBy.mockResolvedValue(mangaWithTotal(90));
      const selectQb = createQb();
      selectQb.getRawOne.mockResolvedValue({
        reporters: '2',
        min_reported: '95',
      });
      const deleteQb = createQb();
      reportRepo.createQueryBuilder
        .mockReturnValueOnce(selectQb)
        .mockReturnValueOnce(deleteQb);
      mangaRepo.createQueryBuilder.mockReturnValue(createQb());

      await service.consolidate(42);

      expect(deleteQb.delete).toHaveBeenCalled();
      expect(deleteQb.andWhere).toHaveBeenCalledWith(
        'reported_total <= :newTotal',
        { newTotal: 95 },
      );
      expect(deleteQb.execute).toHaveBeenCalled();
    });
  });

  describe('getEffectiveTotal', () => {
    it('should return the official total when the user has no report', async () => {
      reportRepo.findOne.mockResolvedValue(null);

      expect(await service.getEffectiveTotal(1, 42, 90)).toBe(90);
      expect(reportRepo.delete).not.toHaveBeenCalled();
    });

    it('should return the reported total when it is still above the official one', async () => {
      reportRepo.findOne.mockResolvedValue({ id: 7, reported_total: 95 });

      expect(await service.getEffectiveTotal(1, 42, 90)).toBe(95);
      expect(reportRepo.delete).not.toHaveBeenCalled();
    });

    it('should lazily purge the report once the official total caught up', async () => {
      reportRepo.findOne.mockResolvedValue({ id: 7, reported_total: 95 });

      expect(await service.getEffectiveTotal(1, 42, 100)).toBe(100);
      expect(reportRepo.delete).toHaveBeenCalledWith(7);
    });
  });

  describe('getUserReportsByMangaIds', () => {
    it('should return an empty map without querying for an empty id list', async () => {
      const result = await service.getUserReportsByMangaIds(1, []);

      expect(result.size).toBe(0);
      expect(reportRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should map mu_id → reported_total in a single IN query', async () => {
      const qb = createQb();
      qb.getRawMany.mockResolvedValue([
        { manga_id: '42', reported_total: '95' },
        { manga_id: '77', reported_total: '120' },
      ]);
      reportRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getUserReportsByMangaIds(1, [42, 77, 99]);

      expect(reportRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(result.get('42')).toBe(95);
      expect(result.get('77')).toBe(120);
      expect(result.has('99')).toBe(false);
    });
  });
});
