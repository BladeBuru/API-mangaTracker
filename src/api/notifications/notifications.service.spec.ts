import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MangaShare } from '@/api/sharing/manga-share.entity';
import { ReadingGroup } from '@/api/sharing/reading-group.entity';
import { Notification } from './notification.entity';
import { NotificationsService } from './notifications.service';
import { NotificationType } from './notification-type';

/** Notification en mémoire, telle que la renvoie le query builder. */
function notif(
  id: string,
  createdAt: string,
  overrides: Partial<Notification> = {},
): Notification {
  return Object.assign(new Notification(), {
    id,
    userId: 1,
    type: NotificationType.FriendRequest,
    actorId: 2,
    actor: { id: 2, username: 'bob', displayName: 'Bob' },
    muId: null,
    manga: null,
    data: { friendshipId: 5 },
    createdAt: new Date(createdAt),
    readAt: null,
    ...overrides,
  });
}

/** Query builder de lecture : chaque `getMany()` dépile la file `pages`. */
function createSelectQb(pages: Notification[][]) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'leftJoin',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
  ]) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn(async () => pages.shift() ?? []);
  return qb;
}

function createUpdateQb(affected: number) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['update', 'set', 'where', 'andWhere']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.execute = jest.fn().mockResolvedValue({ affected });
  return qb;
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  let repo: { createQueryBuilder: jest.Mock; count: jest.Mock };
  let shareRepo: { find: jest.Mock };
  let groupRepo: { find: jest.Mock };

  async function build(qbs: Array<Record<string, jest.Mock>>): Promise<void> {
    repo = {
      createQueryBuilder: jest.fn(() => qbs.shift()),
      count: jest.fn().mockResolvedValue(4),
    };
    shareRepo = { find: jest.fn().mockResolvedValue([]) };
    groupRepo = { find: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getRepositoryToken(Notification), useValue: repo },
        { provide: getRepositoryToken(MangaShare), useValue: shareRepo },
        { provide: getRepositoryToken(ReadingGroup), useValue: groupRepo },
      ],
    }).compile();
    service = moduleRef.get(NotificationsService);
  }

  describe('list — pagination', () => {
    it('should default to 30 items and clamp larger limits to 50', async () => {
      const first = createSelectQb([[]]);
      const second = createSelectQb([[]]);
      await build([first, second]);

      await service.list(1, {});
      await service.list(1, { limit: 500 });

      // limit + 1 pour savoir s'il reste une page.
      expect(first.limit).toHaveBeenCalledWith(31);
      expect(second.limit).toHaveBeenCalledWith(51);
    });

    it('should only read the current user rows, newest first', async () => {
      const qb = createSelectQb([[]]);
      await build([qb]);

      await service.list(7, {});

      expect(qb.where).toHaveBeenCalledWith('n.userId = :userId', {
        userId: 7,
      });
      expect(qb.orderBy).toHaveBeenCalledWith('n.createdAt', 'DESC');
    });

    it('should return nextBefore = createdAt of the last item when more exist', async () => {
      const rows = [
        notif('c', '2026-10-13T10:00:03.000Z'),
        notif('b', '2026-10-13T10:00:02.000Z'),
        notif('a', '2026-10-13T10:00:01.000Z'),
      ];
      await build([createSelectQb([rows])]);

      const page = await service.list(1, { limit: 2 });

      expect(page.items.map((i) => i.id)).toEqual(['c', 'b']);
      expect(page.nextBefore).toBe('2026-10-13T10:00:02.000Z');
      expect(page.unreadCount).toBe(4);
    });

    it('should return nextBefore = null on the last page', async () => {
      await build([createSelectQb([[notif('a', '2026-10-13T10:00:01.000Z')]])]);

      const page = await service.list(1, { limit: 2 });

      expect(page.items).toHaveLength(1);
      expect(page.nextBefore).toBeNull();
    });

    it('should apply the before cursor strictly', async () => {
      const qb = createSelectQb([[]]);
      await build([qb]);

      await service.list(1, { before: '2026-10-13T10:00:02.000Z' });

      expect(qb.andWhere).toHaveBeenCalledWith('n.createdAt < :before', {
        before: new Date('2026-10-13T10:00:02.000Z'),
      });
    });

    it('should serve every row sharing the boundary date (no row skipped by the cursor)', async () => {
      const tie = '2026-10-13T10:00:02.000Z';
      const firstPage = createSelectQb([
        [
          notif('d', '2026-10-13T10:00:03.000Z'),
          notif('c', tie),
          notif('b', tie),
        ],
      ]);
      const ties = createSelectQb([[notif('b', tie), notif('a', tie)]]);
      await build([firstPage, ties]);

      const page = await service.list(1, { limit: 2 });

      expect(ties.andWhere).toHaveBeenCalledWith('n.createdAt = :boundary', {
        boundary: new Date(tie),
      });
      expect(ties.andWhere).toHaveBeenCalledWith('n.id NOT IN (:...seen)', {
        seen: ['d', 'c'],
      });
      expect(page.items.map((i) => i.id)).toEqual(['d', 'c', 'b', 'a']);
      expect(page.nextBefore).toBe(tie);
    });
  });

  describe('list — mapping du contrat', () => {
    it('should expose actor, manga and per-type data, texts read live', async () => {
      const rows = [
        notif('s', '2026-10-13T10:00:03.000Z', {
          type: NotificationType.MangaShare,
          muId: '55',
          manga: {
            mu_id: '55',
            title: 'One Piece',
            medium_cover_url: 'https://cdn/o.jpg',
          } as Notification['manga'],
          data: { shareId: 9 },
        }),
        notif('g', '2026-10-13T10:00:02.000Z', {
          type: NotificationType.ReadingGroupInvite,
          data: { groupId: 3 },
        }),
        notif('x', '2026-10-13T10:00:01.000Z', {
          type: NotificationType.MangaShare,
          data: { shareId: 404 },
          actor: null,
          actorId: null,
        }),
        notif('n', '2026-10-13T10:00:00.000Z', {
          type: NotificationType.NewChapters,
          actor: null,
          actorId: null,
          data: { latestChapter: 47, previousTotal: '40', readChapters: 39 },
          readAt: new Date('2026-10-13T11:00:00.000Z'),
        }),
      ];
      await build([createSelectQb([rows])]);
      shareRepo.find.mockResolvedValue([{ id: 9, message: 'Tu vas adorer' }]);
      groupRepo.find.mockResolvedValue([{ id: 3, name: 'Lecture à deux' }]);

      const { items } = await service.list(1, {});

      expect(items[0]).toEqual({
        id: 's',
        type: 'manga_share',
        createdAt: '2026-10-13T10:00:03.000Z',
        readAt: null,
        actor: { id: 2, username: 'bob', displayName: 'Bob' },
        manga: { muId: 55, title: 'One Piece', coverUrl: 'https://cdn/o.jpg' },
        data: { shareId: 9, message: 'Tu vas adorer' },
      });
      expect(items[1].data).toEqual({
        groupId: 3,
        groupName: 'Lecture à deux',
      });
      // Partage supprimé (compte de l'expéditeur effacé) : plus de texte.
      expect(items[2].data).toEqual({ shareId: 404, message: null });
      expect(items[2].actor).toBeNull();
      expect(items[3]).toMatchObject({
        type: 'new_chapters',
        actor: null,
        manga: null,
        readAt: '2026-10-13T11:00:00.000Z',
        data: { latestChapter: 47, previousTotal: 40, readChapters: 39 },
      });
    });
  });

  describe('acquittements', () => {
    it('should mark the notification read only for its owner, 404 otherwise', async () => {
      const owned = createUpdateQb(1);
      const foreign = createUpdateQb(0);
      await build([owned, foreign]);

      await expect(service.markRead(1, 'uuid-1')).resolves.toEqual({
        ok: true,
      });
      expect(owned.andWhere).toHaveBeenCalledWith('"user_id" = :userId', {
        userId: 1,
      });

      await expect(service.markRead(2, 'uuid-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('should mark all unread notifications of the user and report the count', async () => {
      const qb = createUpdateQb(3);
      await build([qb]);

      await expect(service.markAllRead(1)).resolves.toEqual({ updated: 3 });
      expect(qb.where).toHaveBeenCalledWith('"user_id" = :userId', {
        userId: 1,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('"read_at" IS NULL');
    });

    it('should count unread notifications of the user', async () => {
      await build([]);

      await expect(service.unreadCount(1)).resolves.toBe(4);
      expect(repo.count).toHaveBeenCalledWith({
        where: { userId: 1, readAt: expect.anything() },
      });
    });
  });
});
