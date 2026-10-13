import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Notification } from './notification.entity';
import { NotificationProducerService } from './notification-producer.service';
import { NotificationType } from './notification-type';

/** Query builder chaînable (update / delete) avec capture des clauses. */
function createWriteQb() {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'update',
    'delete',
    'from',
    'set',
    'where',
    'andWhere',
  ]) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.execute = jest.fn().mockResolvedValue({ affected: 1 });
  return qb;
}

describe('NotificationProducerService', () => {
  let service: NotificationProducerService;
  let repo: {
    insert: jest.Mock;
    query: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let qb: Record<string, jest.Mock>;

  beforeEach(async () => {
    qb = createWriteQb();
    repo = {
      insert: jest.fn().mockResolvedValue({}),
      query: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qb),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationProducerService,
        { provide: getRepositoryToken(Notification), useValue: repo },
      ],
    }).compile();
    service = moduleRef.get(NotificationProducerService);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('should notify the addressee of a friend request (actor = requester)', async () => {
    await service.friendRequestSent(12, 1, 2);

    expect(repo.insert).toHaveBeenCalledWith({
      userId: 2,
      actorId: 1,
      type: NotificationType.FriendRequest,
      data: { friendshipId: 12 },
    });
  });

  it('should notify the original requester on acceptance and mark the request read', async () => {
    await service.friendRequestAccepted(12, 1, 2);

    expect(repo.insert).toHaveBeenCalledWith({
      userId: 1,
      actorId: 2,
      type: NotificationType.FriendAccepted,
      data: { friendshipId: 12 },
    });
    // La friend_request de celui qui accepte (2) passe en lue.
    expect(qb.update).toHaveBeenCalledWith(Notification);
    expect(qb.where).toHaveBeenCalledWith('"user_id" = :addresseeId', {
      addresseeId: 2,
    });
    expect(qb.andWhere).toHaveBeenCalledWith(
      '"data" @> CAST(:match AS jsonb)',
      {
        match: JSON.stringify({ friendshipId: 12 }),
      },
    );
  });

  it('should delete the addressee friend_request when the request is withdrawn', async () => {
    await service.friendRequestWithdrawn(12, 2);

    expect(qb.delete).toHaveBeenCalled();
    expect(qb.andWhere).toHaveBeenCalledWith('"type" = :type', {
      type: NotificationType.FriendRequest,
    });
    expect(qb.execute).toHaveBeenCalled();
  });

  it('should create one manga_share per created share, nothing for an empty batch', async () => {
    await service.mangaShared(1, '55', []);
    expect(repo.insert).not.toHaveBeenCalled();

    await service.mangaShared(1, '55', [
      { id: 7, addresseeId: 2 },
      { id: 8, addresseeId: 3 },
    ]);
    expect(repo.insert).toHaveBeenCalledWith([
      {
        userId: 2,
        actorId: 1,
        type: NotificationType.MangaShare,
        muId: '55',
        data: { shareId: 7 },
      },
      {
        userId: 3,
        actorId: 1,
        type: NotificationType.MangaShare,
        muId: '55',
        data: { shareId: 8 },
      },
    ]);
  });

  it('should invite each invitee once, never the inviter', async () => {
    await service.readingGroupInvites(1, 9, '55', [2, 2, 1, 3]);

    const rows = repo.insert.mock.calls[0][0] as Array<{ userId: number }>;
    expect(rows.map((r) => r.userId)).toEqual([2, 3]);
    expect(rows[0]).toMatchObject({
      actorId: 1,
      type: NotificationType.ReadingGroupInvite,
      muId: '55',
      data: { groupId: 9 },
    });
  });

  it('should upsert new_chapters in ONE set-based statement with the previous total', async () => {
    repo.query.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    await expect(service.newChapters(55, 39)).resolves.toBe(2);

    expect(repo.query).toHaveBeenCalledTimes(1);
    const [sql, params] = repo.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO "notification"');
    expect(sql).toContain('ON CONFLICT ("user_id", "mu_id")');
    expect(sql).toContain('"read_at" IS NULL');
    expect(params).toEqual(['55', 39, 'reading', 'caughtUp']);
  });

  it('should never throw: a failed write is logged and the main action goes on', async () => {
    repo.insert.mockRejectedValue(new Error('db down'));
    repo.query.mockRejectedValue(new Error('db down'));
    qb.execute.mockRejectedValue(new Error('db down'));

    await expect(service.friendRequestSent(1, 1, 2)).resolves.toBeUndefined();
    await expect(
      service.friendRequestAccepted(1, 1, 2),
    ).resolves.toBeUndefined();
    await expect(service.friendRequestWithdrawn(1, 2)).resolves.toBeUndefined();
    await expect(
      service.mangaShared(1, '5', [{ id: 1, addresseeId: 2 }]),
    ).resolves.toBeUndefined();
    await expect(service.mangaSharesSeen(2)).resolves.toBeUndefined();
    await expect(
      service.readingGroupInvites(1, 1, '5', [2]),
    ).resolves.toBeUndefined();
    await expect(service.newChapters(5, 1)).resolves.toBe(0);
    expect(Logger.prototype.error).toHaveBeenCalled();
  });
});
