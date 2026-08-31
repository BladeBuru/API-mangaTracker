import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { DismissalService } from './dismissal.service';
import { RecoCacheService } from './reco-cache.service';
import { UserMangaDismissal } from './user-manga-dismissal.entity';
import { DismissalReason } from './dismissal-reason.enum';
import { Manga } from '@/api/mangas/manga.entity';

function makeManga(mu_id: string, title = `Manga ${mu_id}`): Manga {
  const manga = new Manga();
  manga.id = Number(mu_id);
  manga.mu_id = mu_id;
  manga.title = title;
  return manga;
}

describe('DismissalService', () => {
  let service: DismissalService;
  let recoCache: RecoCacheService;

  /** Chaîne d'insertion `insert().into().values().orUpdate().execute()`. */
  let insertChain: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orUpdate: jest.Mock;
    execute: jest.Mock;
  };
  /** Chaîne de lecture raw `select().where().getRawMany()`. */
  let selectChain: {
    select: jest.Mock;
    where: jest.Mock;
    getRawMany: jest.Mock;
  };
  let dismissalRepo: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    delete: jest.Mock;
  };
  let mangaRepo: { findOneBy: jest.Mock };

  beforeEach(async () => {
    insertChain = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    selectChain = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    dismissalRepo = {
      // `createQueryBuilder()` sans alias → insertion ; avec alias → lecture.
      createQueryBuilder: jest.fn((alias?: string) =>
        alias ? selectChain : insertChain,
      ),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    mangaRepo = {
      findOneBy: jest.fn().mockResolvedValue(makeManga('2001', 'One Piece')),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DismissalService,
        RecoCacheService,
        {
          provide: getRepositoryToken(UserMangaDismissal),
          useValue: dismissalRepo,
        },
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
      ],
    }).compile();

    service = module.get<DismissalService>(DismissalService);
    recoCache = module.get<RecoCacheService>(RecoCacheService);
  });

  describe('dismiss', () => {
    it('enregistre le rejet avec sa raison typée', async () => {
      dismissalRepo.findOne.mockResolvedValue({
        id: 7,
        created_at: new Date('2026-08-28T10:00:00Z'),
      });

      const result = await service.dismiss(
        42,
        2001,
        DismissalReason.SeenElsewhere,
      );

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ reason: DismissalReason.SeenElsewhere }),
      );
      expect(result).toEqual({
        muId: 2001,
        title: 'One Piece',
        reason: DismissalReason.SeenElsewhere,
        createdAt: new Date('2026-08-28T10:00:00Z'),
      });
    });

    it('unicité (user, manga) : un second rejet met à jour la raison au lieu de dupliquer', async () => {
      await service.dismiss(42, 2001, DismissalReason.AlreadyRead);

      // `ON CONFLICT (user_id, manga_id) DO UPDATE SET reason = ...` —
      // c'est la contrainte UQ_dismissal_user_manga qui garantit l'unicité,
      // pas un SELECT préalable (pas de fenêtre de course).
      expect(insertChain.orUpdate).toHaveBeenCalledWith(
        ['reason'],
        ['user_id', 'manga_id'],
      );
    });

    it('invalide le cache de recommandations (sinon effet visible dans 1 h seulement)', async () => {
      const spy = jest.spyOn(recoCache, 'invalidateUser');

      await service.dismiss(42, 2001, DismissalReason.NotInterested);

      expect(spy).toHaveBeenCalledWith(42);
    });

    it('404 si le manga est inconnu du catalogue local', async () => {
      mangaRepo.findOneBy.mockResolvedValue(null);

      await expect(
        service.dismiss(42, 9999, DismissalReason.NotInterested),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(insertChain.execute).not.toHaveBeenCalled();
    });
  });

  describe('restore (annulation)', () => {
    it('supprime le rejet et invalide le cache', async () => {
      dismissalRepo.findOne.mockResolvedValue({ id: 7 });
      const spy = jest.spyOn(recoCache, 'invalidateUser');

      await service.restore(42, 2001);

      expect(dismissalRepo.delete).toHaveBeenCalledWith({ id: 7 });
      expect(spy).toHaveBeenCalledWith(42);
    });

    it('404 si aucun rejet n’existe (double annulation)', async () => {
      dismissalRepo.findOne.mockResolvedValue(null);

      await expect(service.restore(42, 2001)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(dismissalRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe('getDismissedMuIds', () => {
    it('retourne les mu_id rejetés sous forme de Set', async () => {
      selectChain.getRawMany.mockResolvedValue([
        { manga_id: '2001' },
        { manga_id: '2002' },
      ]);

      const result = await service.getDismissedMuIds(42);

      expect(result).toEqual(new Set(['2001', '2002']));
      expect(selectChain.where).toHaveBeenCalledWith('d.user_id = :userId', {
        userId: 42,
      });
    });

    it('ne requête pas la base pour la sentinelle cold start (userId <= 0)', async () => {
      const result = await service.getDismissedMuIds(-1);

      expect(result.size).toBe(0);
      expect(dismissalRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('buildExclusionSet', () => {
    it('fusionne bibliothèque et rejets (union, sans doublon)', async () => {
      selectChain.getRawMany.mockResolvedValue([
        { manga_id: '2001' },
        { manga_id: '1000' }, // déjà en biblio → dédupliqué par le Set
      ]);

      const result = await service.buildExclusionSet(42, ['1000', '1001']);

      expect(result).toEqual(new Set(['1000', '1001', '2001']));
    });

    it('retourne la bibliothèque seule quand aucun rejet', async () => {
      const result = await service.buildExclusionSet(42, ['1000']);

      expect(result).toEqual(new Set(['1000']));
    });
  });

  describe('listDismissals', () => {
    it('remonte les titres écartés avec leur raison, du plus récent au plus ancien', async () => {
      const createdAt = new Date('2026-08-28T10:00:00Z');
      dismissalRepo.find.mockResolvedValue([
        {
          id: 1,
          manga: makeManga('2001', 'One Piece'),
          reason: DismissalReason.SeenElsewhere,
          created_at: createdAt,
        },
      ]);

      const result = await service.listDismissals(42);

      expect(result).toEqual([
        {
          muId: 2001,
          title: 'One Piece',
          reason: DismissalReason.SeenElsewhere,
          createdAt,
        },
      ]);
      expect(dismissalRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: { created_at: 'DESC' } }),
      );
    });
  });
});
