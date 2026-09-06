import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { ReadingPositionService } from './reading-position.service';
import { UpdateReadingPositionDto } from './dto/reading-position.dto';

/** Query builder chainable générique (même pattern que library.service.spec). */
const createQb = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['update', 'set', 'setParameter', 'where', 'andWhere']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
  return qb;
};

/** Ligne `user_manga` minimale, avec ou sans position en cours. */
const libraryRow = (position?: {
  chapter: number;
  percent: number;
  updatedAt: Date;
}): Partial<UserManga> => ({
  id: 7,
  user_read_chapters: 12,
  readingStatus: 'reading',
  currentChapter: position?.chapter ?? null,
  currentPositionPercent: position?.percent ?? null,
  currentPositionUpdatedAt: position?.updatedAt ?? null,
});

describe('ReadingPositionService — reprise de lecture inter-appareils', () => {
  let service: ReadingPositionService;
  let userMangaRepo: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let qb: Record<string, jest.Mock>;

  beforeEach(async () => {
    qb = createQb();
    userMangaRepo = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReadingPositionService,
        { provide: getRepositoryToken(UserManga), useValue: userMangaRepo },
      ],
    }).compile();

    service = module.get<ReadingPositionService>(ReadingPositionService);
  });

  /** Champs effectivement écrits par le dernier UPDATE. */
  const writtenFields = () =>
    qb.set.mock.calls[0][0] as Record<string, unknown>;

  describe('écriture (PUT /library/reading-position)', () => {
    it("enregistre la position quand aucune position n'existe encore", async () => {
      userMangaRepo.findOne.mockResolvedValue(libraryRow());

      await expect(service.saveReadingPosition(1, 42, 13, 40)).resolves.toEqual(
        {
          ok: true,
        },
      );

      expect(qb.execute).toHaveBeenCalledTimes(1);
      expect(writtenFields().currentChapter).toBe(13);
      expect(writtenFields().currentPositionPercent).toBe(40);
      expect(writtenFields().currentPositionUpdatedAt).toBeInstanceOf(Date);
    });

    it('ne modifie JAMAIS user_read_chapters, readingStatus ni lastUpdated', async () => {
      userMangaRepo.findOne.mockResolvedValue(libraryRow());

      await service.saveReadingPosition(1, 42, 13, 40);

      const fields = writtenFields();
      expect(fields).not.toHaveProperty('user_read_chapters');
      expect(fields).not.toHaveProperty('readingStatus');
      expect(fields).not.toHaveProperty('lastUpdated');
      expect(Object.keys(fields).sort()).toEqual([
        'currentChapter',
        'currentPositionPercent',
        'currentPositionUpdatedAt',
      ]);
    });

    it("renvoie 404 quand le manga n'est pas dans la bibliothèque", async () => {
      userMangaRepo.findOne.mockResolvedValue(null);

      await expect(service.saveReadingPosition(1, 42, 13, 40)).rejects.toThrow(
        NotFoundException,
      );
      expect(qb.execute).not.toHaveBeenCalled();
    });

    it('arrondit un pourcentage fractionnaire (colonne smallint)', async () => {
      userMangaRepo.findOne.mockResolvedValue(libraryRow());

      await service.saveReadingPosition(1, 42, 13, 42.7);

      expect(writtenFields().currentPositionPercent).toBe(43);
    });

    it('ignore silencieusement une position en retrait sur le même chapitre (appareil en retard)', async () => {
      userMangaRepo.findOne.mockResolvedValue(
        libraryRow({ chapter: 13, percent: 80, updatedAt: new Date() }),
      );

      // Le téléphone vide sa file d'attente pendant qu'on lit sur la tablette.
      await expect(service.saveReadingPosition(1, 42, 13, 60)).resolves.toEqual(
        {
          ok: true,
        },
      );

      expect(qb.execute).not.toHaveBeenCalled();
    });

    it('accepte une progression en avant sur le même chapitre', async () => {
      userMangaRepo.findOne.mockResolvedValue(
        libraryRow({ chapter: 13, percent: 60, updatedAt: new Date() }),
      );

      await service.saveReadingPosition(1, 42, 13, 80);

      expect(qb.execute).toHaveBeenCalledTimes(1);
      expect(writtenFields().currentPositionPercent).toBe(80);
    });

    it('accepte une position égale (écriture idempotente du client qui rejoue)', async () => {
      userMangaRepo.findOne.mockResolvedValue(
        libraryRow({ chapter: 13, percent: 60, updatedAt: new Date() }),
      );

      await service.saveReadingPosition(1, 42, 13, 60);

      expect(qb.execute).toHaveBeenCalledTimes(1);
    });

    it('accepte un retour en arrière une fois la fenêtre de grâce écoulée (vraie relecture)', async () => {
      userMangaRepo.findOne.mockResolvedValue(
        libraryRow({
          chapter: 13,
          percent: 80,
          updatedAt: new Date(Date.now() - 10 * 60_000),
        }),
      );

      await service.saveReadingPosition(1, 42, 13, 20);

      expect(qb.execute).toHaveBeenCalledTimes(1);
      expect(writtenFields().currentPositionPercent).toBe(20);
    });

    it('accepte toujours un changement de chapitre (navigation délibérée, pas un rejeu)', async () => {
      userMangaRepo.findOne.mockResolvedValue(
        libraryRow({ chapter: 13, percent: 80, updatedAt: new Date() }),
      );

      await service.saveReadingPosition(1, 42, 14, 5);

      expect(qb.execute).toHaveBeenCalledTimes(1);
      expect(writtenFields().currentChapter).toBe(14);
    });

    it('reste non bloquante si la base échoue (télémétrie de confort)', async () => {
      userMangaRepo.findOne.mockResolvedValue(libraryRow());
      qb.execute.mockRejectedValue(new Error('deadlock detected'));

      await expect(service.saveReadingPosition(1, 42, 13, 40)).resolves.toEqual(
        {
          ok: true,
        },
      );
    });
  });

  describe('lecture (GET /library/:muId/reading-position)', () => {
    it("renvoie null quand aucune position n'est enregistrée (→ 204)", async () => {
      userMangaRepo.findOne.mockResolvedValue(libraryRow());

      await expect(service.getReadingPosition(1, 42)).resolves.toBeNull();
    });

    it("renvoie null quand le manga n'est pas dans la bibliothèque (→ 204)", async () => {
      userMangaRepo.findOne.mockResolvedValue(null);

      await expect(service.getReadingPosition(1, 42)).resolves.toBeNull();
    });

    it('renvoie la position avec un horodatage ISO 8601', async () => {
      const updatedAt = new Date('2026-09-06T12:34:56.000Z');
      userMangaRepo.findOne.mockResolvedValue(
        libraryRow({ chapter: 13, percent: 42, updatedAt }),
      );

      await expect(service.getReadingPosition(1, 42)).resolves.toEqual({
        chapter: 13,
        positionPercent: 42,
        updatedAt: '2026-09-06T12:34:56.000Z',
      });
    });
  });
});

describe('UpdateReadingPositionDto — bornes (400)', () => {
  const buildDto = (payload: Partial<UpdateReadingPositionDto>) => {
    const dto = new UpdateReadingPositionDto();
    Object.assign(dto, { muId: 42, chapter: 13, positionPercent: 40 }, payload);
    return dto;
  };

  const failingProperties = async (
    payload: Partial<UpdateReadingPositionDto>,
  ) => (await validate(buildDto(payload))).map((error) => error.property);

  it('accepte un payload nominal', async () => {
    expect(await failingProperties({})).toEqual([]);
  });

  it('accepte les bornes 0 et 100', async () => {
    expect(await failingProperties({ positionPercent: 0 })).toEqual([]);
    expect(await failingProperties({ positionPercent: 100 })).toEqual([]);
    expect(await failingProperties({ chapter: 0 })).toEqual([]);
  });

  it('rejette un pourcentage négatif', async () => {
    expect(await failingProperties({ positionPercent: -1 })).toEqual([
      'positionPercent',
    ]);
  });

  it('rejette un pourcentage supérieur à 100', async () => {
    expect(await failingProperties({ positionPercent: 101 })).toEqual([
      'positionPercent',
    ]);
  });

  it('rejette un chapitre négatif', async () => {
    expect(await failingProperties({ chapter: -1 })).toEqual(['chapter']);
  });

  it('accepte un pourcentage fractionnaire (arrondi côté service)', async () => {
    expect(await failingProperties({ positionPercent: 42.7 })).toEqual([]);
  });
});
