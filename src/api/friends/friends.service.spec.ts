import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import User from '@/api/user/user.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { NotificationProducerService } from '@/api/notifications/notification-producer.service';
import { FriendsService } from './friends.service';
import { FriendshipStatus, UserFriendship } from './user-friendship.entity';

const alice = { id: 1, username: 'alice', displayName: null } as User;
const bob = { id: 2, username: 'bob', displayName: null } as User;

/** Relation en mémoire (requester → addressee). */
function friendship(
  requester: User,
  addressee: User,
  status: FriendshipStatus,
): UserFriendship {
  return Object.assign(new UserFriendship(), {
    id: 12,
    requester,
    addressee,
    status,
    createdAt: new Date('2026-10-13T10:00:00.000Z'),
    acceptedAt: null,
  });
}

describe('FriendsService', () => {
  let service: FriendsService;
  let friendshipRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
  };
  let notifications: Record<string, jest.Mock>;

  beforeEach(async () => {
    friendshipRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      // Une nouvelle ligne reçoit son id à l'insertion, comme en base.
      save: jest.fn(async (f: UserFriendship) =>
        Object.assign(f, { id: f.id ?? 12 }),
      ),
      remove: jest.fn(async (f: UserFriendship) => f),
    };
    notifications = {
      friendRequestSent: jest.fn(),
      friendRequestAccepted: jest.fn(),
      friendRequestHandled: jest.fn(),
      friendRequestWithdrawn: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        FriendsService,
        {
          provide: getRepositoryToken(UserFriendship),
          useValue: friendshipRepo,
        },
        {
          provide: getRepositoryToken(User),
          useValue: { findOneBy: jest.fn().mockResolvedValue(bob) },
        },
        { provide: getRepositoryToken(UserManga), useValue: {} },
        { provide: NotificationProducerService, useValue: notifications },
      ],
    }).compile();
    service = moduleRef.get(FriendsService);
  });

  describe('sendRequest — relation existante', () => {
    it('should answer 409 « demande déjà envoyée » for a pending request I sent', async () => {
      friendshipRepo.findOne.mockResolvedValue(
        friendship(alice, bob, FriendshipStatus.Pending),
      );

      await expect(
        service.sendRequest(alice.id, { addresseeId: bob.id }),
      ).rejects.toThrow(new ConflictException("Demande d'amitié déjà envoyée"));
    });

    it('should answer 409 « vous êtes déjà amis » for an accepted friendship', async () => {
      friendshipRepo.findOne.mockResolvedValue(
        friendship(bob, alice, FriendshipStatus.Accepted),
      );

      await expect(
        service.sendRequest(alice.id, { addresseeId: bob.id }),
      ).rejects.toThrow(new ConflictException('Vous êtes déjà amis'));
    });

    it('should keep 403 for a blocked relation', async () => {
      friendshipRepo.findOne.mockResolvedValue(
        friendship(alice, bob, FriendshipStatus.Blocked),
      );

      await expect(
        service.sendRequest(alice.id, { addresseeId: bob.id }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('should auto-accept a crossed request and notify the original requester', async () => {
      // Bob avait déjà demandé Alice : la demande d'Alice vaut acceptation.
      friendshipRepo.findOne.mockResolvedValue(
        friendship(bob, alice, FriendshipStatus.Pending),
      );

      const dto = await service.sendRequest(alice.id, { addresseeId: bob.id });

      expect(dto.status).toBe(FriendshipStatus.Accepted);
      expect(notifications.friendRequestAccepted).toHaveBeenCalledWith(
        12,
        bob.id,
        alice.id,
      );
      expect(notifications.friendRequestSent).not.toHaveBeenCalled();
    });
  });

  it('should notify the addressee of a new request', async () => {
    friendshipRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(friendship(alice, bob, FriendshipStatus.Pending));

    await service.sendRequest(alice.id, { addresseeId: bob.id });

    expect(notifications.friendRequestSent).toHaveBeenCalledWith(
      12,
      alice.id,
      bob.id,
    );
  });

  it('should translate a concurrent duplicate insert into 409', async () => {
    friendshipRepo.findOne.mockResolvedValue(null);
    friendshipRepo.save.mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: '23505' }),
    );

    await expect(
      service.sendRequest(alice.id, { addresseeId: bob.id }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(notifications.friendRequestSent).not.toHaveBeenCalled();
  });

  it('should notify the requester when the addressee accepts (PATCH)', async () => {
    friendshipRepo.findOne.mockResolvedValue(
      friendship(alice, bob, FriendshipStatus.Pending),
    );

    await service.updateStatus(bob.id, 12, FriendshipStatus.Accepted);

    expect(notifications.friendRequestAccepted).toHaveBeenCalledWith(
      12,
      alice.id,
      bob.id,
    );
  });

  it('should let the REQUESTER cancel a pending request and withdraw the notification', async () => {
    friendshipRepo.findOne.mockResolvedValue(
      friendship(alice, bob, FriendshipStatus.Pending),
    );

    await service.deleteFriendship(alice.id, 12);

    expect(friendshipRepo.remove).toHaveBeenCalled();
    expect(notifications.friendRequestWithdrawn).toHaveBeenCalledWith(
      12,
      bob.id,
    );
  });

  it('should not touch notifications when an accepted friendship is deleted', async () => {
    friendshipRepo.findOne.mockResolvedValue(
      friendship(alice, bob, FriendshipStatus.Accepted),
    );

    await service.deleteFriendship(bob.id, 12);

    expect(notifications.friendRequestWithdrawn).not.toHaveBeenCalled();
  });

  it('should list pending requests I SENT with the addressee as the other user', async () => {
    friendshipRepo.find.mockResolvedValue([
      friendship(alice, bob, FriendshipStatus.Pending),
    ]);

    const [sent] = await service.listPendingSent(alice.id);

    expect(friendshipRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          requester: { id: alice.id },
          status: FriendshipStatus.Pending,
        },
      }),
    );
    expect(sent).toMatchObject({
      id: 12,
      direction: 'sent',
      otherUserId: bob.id,
      otherUsername: 'bob',
    });
  });
});
