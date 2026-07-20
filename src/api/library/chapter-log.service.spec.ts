import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import {
  BACKFILL_CAP,
  ChapterLogService,
  DEDUP_WINDOW_MINUTES,
} from './chapter-log.service';
import { UserMangaChapterLog } from './user-manga-chapter-log.entity';
import { Manga } from '@/api/mangas/manga.entity';

/** Query builder chainable pour le lookup de dédup. */
const createQb = (getOneResult: UserMangaChapterLog | null = null) => {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['where', 'andWhere', 'orderBy']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getOne = jest.fn().mockResolvedValue(getOneResult);
  return qb;
};

const existingLog = (chapterNumber: number): UserMangaChapterLog =>
  ({
    id: 5,
    chapterNumber,
    isSkipped: false,
    isBonus: false,
    scrollPosition: null,
    readAt: new Date(),
  } as UserMangaChapterLog);

describe('ChapterLogService', () => {
  let service: ChapterLogService;
  let logRepo: {
    save: jest.Mock;
    insert: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let mangaRepo: { findOneBy: jest.Mock };

  beforeEach(async () => {
    logRepo = {
      save: jest.fn(),
      insert: jest.fn().mockResolvedValue({}),
      find: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(createQb(null)),
    };
    mangaRepo = {
      findOneBy: jest.fn().mockResolvedValue({ mu_id: '42', title: 'T' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChapterLogService,
        { provide: getRepositoryToken(UserMangaChapterLog), useValue: logRepo },
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
      ],
    }).compile();

    service = module.get<ChapterLogService>(ChapterLogService);
  });

  describe('recordChapterRead — fenêtre de dédup (B-5)', () => {
    it('should reuse the existing row (no new insert) but REFRESH scroll/bonus when logged less than 10 minutes ago', async () => {
      const qb = createQb(existingLog(42));
      logRepo.createQueryBuilder.mockReturnValue(qb);
      logRepo.save.mockImplementation(async (log: UserMangaChapterLog) => log);

      const dto = await service.recordChapterRead(1, 42, {
        chapterNumber: 42,
        scrollPosition: 5000,
        isBonus: true,
      });

      // Dédup : on réutilise la MÊME ligne (id 5), pas de nouvelle ligne.
      expect(dto.id).toBe(5);
      // ...mais on persiste les données fraîches (scroll + bonus) au lieu
      // de renvoyer la ligne inchangée.
      expect(logRepo.save).toHaveBeenCalledTimes(1);
      const saved: UserMangaChapterLog = logRepo.save.mock.calls[0][0];
      expect(saved.id).toBe(5);
      expect(saved.scrollPosition).toBe(5000);
      expect(saved.isBonus).toBe(true);
      expect(dto.scrollPosition).toBe(5000);
      expect(dto.isBonus).toBe(true);
      // Le filtre temporel est bien borné à now - DEDUP_WINDOW_MINUTES.
      const readAtCall = qb.andWhere.mock.calls.find(
        (call) => call[0] === 'log.readAt >= :windowStart',
      );
      expect(readAtCall).toBeDefined();
      const windowStart: Date = readAtCall[1].windowStart;
      const expectedMs = Date.now() - DEDUP_WINDOW_MINUTES * 60 * 1000;
      expect(Math.abs(windowStart.getTime() - expectedMs)).toBeLessThan(5000);
    });

    it('should NOT overwrite scroll/bonus when the body omits them (undefined = préserve)', async () => {
      const existing = existingLog(42);
      existing.scrollPosition = 1234;
      existing.isBonus = true;
      logRepo.createQueryBuilder.mockReturnValue(createQb(existing));
      logRepo.save.mockImplementation(async (log: UserMangaChapterLog) => log);

      const dto = await service.recordChapterRead(1, 42, {
        chapterNumber: 42,
      });

      // Body sans scrollPosition/isBonus → les valeurs existantes restent.
      const saved: UserMangaChapterLog = logRepo.save.mock.calls[0][0];
      expect(saved.scrollPosition).toBe(1234);
      expect(saved.isBonus).toBe(true);
      expect(dto.scrollPosition).toBe(1234);
      expect(dto.isBonus).toBe(true);
    });

    it('should insert a new row when the last read of this chapter is older than the window', async () => {
      // Une ligne plus vieille que la fenêtre n'est pas retournée par la
      // requête filtrée (readAt >= now - 10 min) → getOne = null → replay.
      logRepo.createQueryBuilder.mockReturnValue(createQb(null));
      logRepo.save.mockImplementation(async (log: UserMangaChapterLog) => ({
        ...log,
        id: 9,
        readAt: new Date(),
      }));

      const dto = await service.recordChapterRead(1, 42, {
        chapterNumber: 42,
      });

      expect(logRepo.save).toHaveBeenCalledTimes(1);
      expect(dto.id).toBe(9);
      expect(dto.chapterNumber).toBe(42);
    });
  });

  describe('recordBackfill (Chantier B)', () => {
    it('should insert chapters oldRead+1..newRead in a single multi-row insert', async () => {
      const inserted = await service.recordBackfill(1, 42, 90, 95);

      expect(inserted).toBe(5);
      expect(logRepo.insert).toHaveBeenCalledTimes(1);
      const rows: UserMangaChapterLog[] = logRepo.insert.mock.calls[0][0];
      expect(rows).toHaveLength(5);
      expect(rows.map((r) => r.chapterNumber)).toEqual([91, 92, 93, 94, 95]);
      for (const row of rows) {
        expect(row.isSkipped).toBe(false);
        expect(row.isBonus).toBe(false);
        expect(row.scrollPosition).toBeNull();
        expect(row.manga.mu_id).toBe('42');
        expect(row.user.id).toBe(1);
      }
    });

    it('should cap at BACKFILL_CAP rows and only log the LAST chapters (delta 1200 → 500 derniers)', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const inserted = await service.recordBackfill(1, 42, 0, 1200);

      expect(inserted).toBe(BACKFILL_CAP);
      // Chunks de 100 → 5 INSERT pour 500 lignes.
      expect(logRepo.insert).toHaveBeenCalledTimes(5);
      const allRows: UserMangaChapterLog[] = logRepo.insert.mock.calls.flatMap(
        (call) => call[0],
      );
      expect(allRows).toHaveLength(BACKFILL_CAP);
      expect(allRows[0].chapterNumber).toBe(701);
      expect(allRows[allRows.length - 1].chapterNumber).toBe(1200);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('should skip the terminal chapter when the reader just logged it (dédup B-5)', async () => {
      logRepo.createQueryBuilder.mockReturnValue(createQb(existingLog(95)));

      const inserted = await service.recordBackfill(1, 42, 90, 95);

      expect(inserted).toBe(4);
      const rows: UserMangaChapterLog[] = logRepo.insert.mock.calls[0][0];
      expect(rows.map((r) => r.chapterNumber)).toEqual([91, 92, 93, 94]);
    });

    it('should be a no-op on a decrement or equal pointer (B-4)', async () => {
      expect(await service.recordBackfill(1, 42, 95, 90)).toBe(0);
      expect(await service.recordBackfill(1, 42, 95, 95)).toBe(0);
      expect(logRepo.insert).not.toHaveBeenCalled();
      expect(logRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('should use the transactional EntityManager repository when provided', async () => {
      const managerRepo = {
        insert: jest.fn().mockResolvedValue({}),
        createQueryBuilder: jest.fn().mockReturnValue(createQb(null)),
      };
      const manager = {
        getRepository: jest.fn().mockReturnValue(managerRepo),
      };

      const inserted = await service.recordBackfill(
        1,
        42,
        90,
        95,
        manager as never,
      );

      expect(inserted).toBe(5);
      expect(manager.getRepository).toHaveBeenCalledWith(UserMangaChapterLog);
      expect(managerRepo.insert).toHaveBeenCalledTimes(1);
      expect(logRepo.insert).not.toHaveBeenCalled();
    });
  });
});
