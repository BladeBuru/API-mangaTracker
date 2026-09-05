import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { ReadingStatus } from './reading-status.enum';
import { ReadingStatusAutoUpdateService } from './reading-status-auto-update.service';

/** Query builder d'UPDATE chainable, avec capture des clauses. */
function createUpdateQb(affected: number | undefined) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['update', 'set', 'where', 'andWhere']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.execute = jest.fn().mockResolvedValue({ affected });
  return qb;
}

describe('ReadingStatusAutoUpdateService', () => {
  let service: ReadingStatusAutoUpdateService;
  let userMangaRepo: { createQueryBuilder: jest.Mock };

  async function build(qb: Record<string, jest.Mock>): Promise<void> {
    userMangaRepo = { createQueryBuilder: jest.fn(() => qb) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReadingStatusAutoUpdateService,
        { provide: getRepositoryToken(UserManga), useValue: userMangaRepo },
      ],
    }).compile();
    service = module.get(ReadingStatusAutoUpdateService);
  }

  it('bascule « à jour » → « en cours » en UNE requête ensembliste par manga', async () => {
    const qb = createUpdateQb(3);
    await build(qb);

    const flipped = await service.flipCaughtUpToReading(42);

    expect(flipped).toBe(3);
    // Une seule requête, quel que soit le nombre d'utilisateurs concernés.
    expect(userMangaRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(qb.update).toHaveBeenCalledWith(UserManga);

    const setArg = qb.set.mock.calls[0][0];
    expect(setArg.readingStatus).toBe(ReadingStatus.Reading);
    expect(setArg.lastUpdated).toBeInstanceOf(Date);

    // Ciblage : ce manga, entrées « à jour » uniquement, et SEULEMENT celles
    // dont la progression est en retard sur le total désormais en base.
    expect(qb.where).toHaveBeenCalledWith('manga_id = :muId', { muId: '42' });
    expect(qb.andWhere).toHaveBeenCalledWith('"readingStatus" = :caughtUp', {
      caughtUp: ReadingStatus.CaughtUp,
    });
    const progressClause: string = qb.andWhere.mock.calls[1][0];
    expect(progressClause).toContain('user_read_chapters <');
    expect(progressClause).toContain('SELECT m.total_chapters FROM manga m');
    expect(progressClause).toContain('m.mu_id = "user_manga"."manga_id"');
  });

  it('accepte un mu_id numérique ou chaîne (colonne bigint → paramètre string)', async () => {
    const qb = createUpdateQb(1);
    await build(qb);

    await service.flipCaughtUpToReading('64156727159');

    expect(qb.where).toHaveBeenCalledWith('manga_id = :muId', {
      muId: '64156727159',
    });
  });

  it('renvoie 0 sans logger quand aucune entrée ne correspond', async () => {
    const qb = createUpdateQb(0);
    await build(qb);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    expect(await service.flipCaughtUpToReading(42)).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('tolère un UpdateResult sans `affected` (driver muet) → 0', async () => {
    const qb = createUpdateQb(undefined);
    await build(qb);

    expect(await service.flipCaughtUpToReading(42)).toBe(0);
  });

  it('journalise le nombre de lignes basculées', async () => {
    const qb = createUpdateQb(2);
    await build(qb);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    await service.flipCaughtUpToReading(42);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2 entrée(s)'));
    logSpy.mockRestore();
  });

  it("n'échoue jamais l'appelant : une erreur BDD est journalisée et renvoie 0", async () => {
    const qb = createUpdateQb(1);
    qb.execute = jest.fn().mockRejectedValue(new Error('DB down'));
    await build(qb);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    await expect(service.flipCaughtUpToReading(42)).resolves.toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('DB down'));
    errorSpy.mockRestore();
  });
});
