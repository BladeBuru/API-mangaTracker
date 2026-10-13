import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { NotificationProducerService } from '@/api/notifications/notification-producer.service';
import {
  FriendshipStatus,
  UserFriendship,
} from '../friends/user-friendship.entity';
import { MangaShare } from './manga-share.entity';
import { SharingService } from './sharing.service';

describe('SharingService — notifications', () => {
  let service: SharingService;
  let shareRepo: {
    find: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let notifications: { mangaShared: jest.Mock; mangaSharesSeen: jest.Mock };
  let nextId: number;

  beforeEach(async () => {
    nextId = 100;
    const updateQb: Record<string, jest.Mock> = {};
    for (const method of ['update', 'set', 'where', 'andWhere']) {
      updateQb[method] = jest.fn().mockReturnValue(updateQb);
    }
    updateQb.execute = jest.fn().mockResolvedValue({ affected: 2 });
    shareRepo = {
      // 1er find : partages non vus existants (Bob en a déjà un) ; 2e : re-fetch.
      find: jest
        .fn()
        .mockResolvedValueOnce([{ addressee: { id: 2 } }])
        .mockResolvedValueOnce([]),
      save: jest.fn(async (share: MangaShare) => ({ ...share, id: nextId++ })),
      createQueryBuilder: jest.fn(() => updateQb),
    };
    notifications = {
      mangaShared: jest.fn(),
      mangaSharesSeen: jest.fn(),
    };
    const accepted = (otherId: number) => ({
      requester: { id: 1 },
      addressee: { id: otherId },
      status: FriendshipStatus.Accepted,
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        SharingService,
        { provide: getRepositoryToken(MangaShare), useValue: shareRepo },
        {
          provide: getRepositoryToken(Manga),
          useValue: {
            findOneBy: jest.fn().mockResolvedValue({ mu_id: '55', title: 'X' }),
          },
        },
        {
          provide: getRepositoryToken(UserFriendship),
          useValue: {
            find: jest.fn().mockResolvedValue([accepted(2), accepted(3)]),
          },
        },
        { provide: NotificationProducerService, useValue: notifications },
      ],
    }).compile();
    service = moduleRef.get(SharingService);
  });

  it('should notify only the addressees whose share was actually created', async () => {
    await service.shareWithFriends(1, 55, { friendIds: [2, 3] });

    // Bob (2) avait déjà un partage non vu : ignoré, donc pas notifié.
    expect(notifications.mangaShared).toHaveBeenCalledWith(1, '55', [
      { id: 100, addresseeId: 3 },
    ]);
  });

  it('should mark manga_share notifications read when the inbox is marked seen', async () => {
    await expect(service.markAllSeen(2)).resolves.toEqual({ updated: 2 });

    expect(notifications.mangaSharesSeen).toHaveBeenCalledWith(2);
  });
});
