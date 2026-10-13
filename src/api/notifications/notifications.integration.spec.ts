import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import {
  hasIntegrationDatabase,
  openIntegrationDatabase,
} from '@/shared/testing/integration-db.helper-spec';
import User from '@/api/user/user.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { UserSession } from '@/api/user/auth/user-session.entity';
import { UserMangaRecommendation } from '@/api/community/user-manga-recommendation.entity';
import {
  FriendshipStatus,
  UserFriendship,
} from '@/api/friends/user-friendship.entity';
import { FriendsService } from '@/api/friends/friends.service';
import { FriendRelation } from '@/api/friends/dto/friend.dto';
import { MangaShare } from '@/api/sharing/manga-share.entity';
import {
  ReadingGroup,
  ReadingGroupMember,
} from '@/api/sharing/reading-group.entity';
import { SharingService } from '@/api/sharing/sharing.service';
import { ReadingGroupsService } from '@/api/sharing/reading-groups.service';
import { ReadingStatusAutoUpdateService } from '@/api/library/reading-status-auto-update.service';
import { ReadingStatus } from '@/api/library/reading-status.enum';
import { GdprService } from '@/api/user/gdpr/gdpr.service';
import { Notification } from './notification.entity';
import { NotificationProducerService } from './notification-producer.service';
import { NotificationsService } from './notifications.service';
import { NotificationRetentionService } from './notification-retention.service';
import { NotificationType } from './notification-type';

/**
 * Tests d'intégration sur un VRAI PostgreSQL (migrations comprises) : upsert
 * `ON CONFLICT` sur index partiel, recherche `translate()`, `jsonb @>`,
 * cascades et `SET NULL` ne se vérifient pas avec des mocks.
 *
 * Ignorés sans `DATABASE_HOST` (poste de dev), toujours exécutés en CI.
 */
(hasIntegrationDatabase ? describe : describe.skip)(
  'Notifications — intégration PostgreSQL',
  () => {
    jest.setTimeout(120_000);

    let ds: DataSource;
    let closeDb: (() => Promise<void>) | undefined;
    let notifications: Repository<Notification>;
    let producer: NotificationProducerService;
    let reader: NotificationsService;
    let friends: FriendsService;
    let sharing: SharingService;
    let groups: ReadingGroupsService;
    let autoUpdate: ReadingStatusAutoUpdateService;
    let alice: User;
    let bob: User;
    let carol: User;
    let dave: User;

    const MANGA = '1001';

    beforeAll(async () => {
      const db = await openIntegrationDatabase();
      ds = db.ds;
      closeDb = db.close;
      notifications = ds.getRepository(Notification);
      producer = new NotificationProducerService(notifications);
      reader = new NotificationsService(
        notifications,
        ds.getRepository(MangaShare),
        ds.getRepository(ReadingGroup),
      );
      friends = new FriendsService(
        ds.getRepository(UserFriendship),
        ds.getRepository(User),
        ds.getRepository(UserManga),
        producer,
      );
      sharing = new SharingService(
        ds.getRepository(MangaShare),
        ds.getRepository(Manga),
        ds.getRepository(UserFriendship),
        producer,
      );
      groups = new ReadingGroupsService(
        ds.getRepository(ReadingGroup),
        ds.getRepository(ReadingGroupMember),
        ds.getRepository(Manga),
        ds.getRepository(UserManga),
        ds.getRepository(UserFriendship),
        producer,
      );
      autoUpdate = new ReadingStatusAutoUpdateService(
        ds.getRepository(UserManga),
        producer,
      );
    });

    afterAll(async () => {
      await closeDb?.();
    });

    beforeEach(async () => {
      await ds.query(
        'TRUNCATE notification, manga_share, reading_group_member, reading_group, ' +
          'user_friendship, user_manga, manga, "user" RESTART IDENTITY CASCADE',
      );
      const users = ds.getRepository(User);
      [alice, bob, carol, dave] = await users.save([
        users.create({ username: 'alice', email: 'a@example.test' }),
        users.create({ username: 'bob', email: 'b@example.test' }),
        users.create({
          username: 'carol',
          email: 'c@example.test',
          displayName: 'Hélène Dupré',
        }),
        users.create({ username: 'dave', email: 'd@example.test' }),
      ]);
      await ds.getRepository(Manga).save({
        mu_id: MANGA,
        title: 'One Piece',
        total_chapters: 40,
        medium_cover_url: 'https://cdn/o.jpg',
      });
    });

    const addToLibrary = (user: User, status: ReadingStatus, read: number) =>
      ds.getRepository(UserManga).save({
        user,
        manga: { mu_id: MANGA } as Manga,
        readingStatus: status,
        user_read_chapters: read,
      });

    const raiseTotal = async (from: number, to: number) => {
      await ds.query('UPDATE manga SET total_chapters = $1 WHERE mu_id = $2', [
        to,
        MANGA,
      ]);
      await autoUpdate.onTotalChaptersIncreased(MANGA, from);
    };

    const ofType = (userId: number, type: NotificationType) =>
      notifications.find({
        where: { userId, type },
        order: { createdAt: 'ASC' },
      });

    describe('nouveaux chapitres (job des sorties)', () => {
      it('notifie une fois par (lecteur, manga), cumule les hausses, recrée après lecture', async () => {
        await addToLibrary(alice, ReadingStatus.Reading, 39);
        await addToLibrary(bob, ReadingStatus.CaughtUp, 40);
        await addToLibrary(carol, ReadingStatus.ReadLater, 10);
        await addToLibrary(dave, ReadingStatus.Completed, 40);

        await raiseTotal(40, 47);

        const first = await notifications.find({ order: { userId: 'ASC' } });
        expect(first.map((n) => n.userId)).toEqual([alice.id, bob.id]);
        expect(first[0]).toMatchObject({
          type: NotificationType.NewChapters,
          muId: MANGA,
          actorId: null,
          data: { latestChapter: 47, previousTotal: 40, readChapters: 39 },
        });
        // Bascule « à jour » → « en cours » toujours faite.
        const bobEntry = await ds
          .getRepository(UserManga)
          .findOneBy({ user: { id: bob.id } });
        expect(bobEntry?.readingStatus).toBe(ReadingStatus.Reading);

        // Deuxième hausse : MISE À JOUR de la notification non lue.
        await raiseTotal(47, 50);
        const [aliceNotif, ...others] = await ofType(
          alice.id,
          NotificationType.NewChapters,
        );
        expect(others).toHaveLength(0);
        expect(aliceNotif.data).toEqual({
          latestChapter: 50,
          previousTotal: 40,
          readChapters: 39,
        });
        expect(aliceNotif.createdAt.getTime()).toBeGreaterThanOrEqual(
          first[0].createdAt.getTime(),
        );
        expect(await notifications.count()).toBe(2);

        // Lue → la hausse suivante en crée une nouvelle.
        await reader.markRead(alice.id, aliceNotif.id);
        await raiseTotal(50, 52);
        const afterRead = await ofType(alice.id, NotificationType.NewChapters);
        expect(afterRead).toHaveLength(2);
        expect(afterRead.filter((n) => n.readAt === null)).toHaveLength(1);
      });

      it('ne notifie pas un lecteur déjà au niveau du nouveau total', async () => {
        await addToLibrary(alice, ReadingStatus.Reading, 47);
        await raiseTotal(40, 47);
        expect(await notifications.count()).toBe(0);
      });
    });

    describe('amis', () => {
      it('demande → friend_request ; acceptation croisée → friend_accepted ; 409 explicites', async () => {
        const sent = await friends.sendRequest(alice.id, {
          addresseeId: bob.id,
        });
        const [request] = await ofType(bob.id, NotificationType.FriendRequest);
        expect(request).toMatchObject({
          actorId: alice.id,
          data: { friendshipId: sent.id },
          readAt: null,
        });

        await expect(
          friends.sendRequest(alice.id, { addresseeId: bob.id }),
        ).rejects.toThrow(
          new ConflictException("Demande d'amitié déjà envoyée"),
        );
        expect(await friends.listPendingSent(alice.id)).toEqual([
          expect.objectContaining({
            id: sent.id,
            direction: 'sent',
            otherUserId: bob.id,
          }),
        ]);

        // Bob « renvoie » une demande : acceptation automatique.
        await friends.sendRequest(bob.id, { addresseeUsername: 'ALICE' });
        const [accepted] = await ofType(
          alice.id,
          NotificationType.FriendAccepted,
        );
        expect(accepted).toMatchObject({
          actorId: bob.id,
          data: { friendshipId: sent.id },
        });
        const [handled] = await ofType(bob.id, NotificationType.FriendRequest);
        expect(handled.readAt).not.toBeNull();

        await expect(
          friends.sendRequest(alice.id, { addresseeId: bob.id }),
        ).rejects.toThrow(new ConflictException('Vous êtes déjà amis'));
      });

      it('PATCH accept → friend_accepted ; annulation par le demandeur → friend_request supprimée', async () => {
        const toBob = await friends.sendRequest(alice.id, {
          addresseeId: bob.id,
        });
        await friends.updateStatus(bob.id, toBob.id, FriendshipStatus.Accepted);
        expect(
          await ofType(alice.id, NotificationType.FriendAccepted),
        ).toHaveLength(1);

        const toDave = await friends.sendRequest(carol.id, {
          addresseeId: dave.id,
        });
        expect(
          await ofType(dave.id, NotificationType.FriendRequest),
        ).toHaveLength(1);
        await friends.deleteFriendship(carol.id, toDave.id);
        expect(
          await ofType(dave.id, NotificationType.FriendRequest),
        ).toHaveLength(0);
      });

      it('recherche : nom affiché, sans casse ni accents, avec l’état de la relation ; bloqués masqués', async () => {
        await friends.sendRequest(alice.id, { addresseeId: bob.id });

        const byDisplayName = await friends.searchUsers(alice.id, 'helene');
        expect(byDisplayName).toEqual([
          expect.objectContaining({
            id: carol.id,
            username: 'carol',
            displayName: 'Hélène Dupré',
            relation: FriendRelation.None,
          }),
        ]);
        expect(
          (await friends.searchUsers(alice.id, 'HÉLÈ')).map((u) => u.id),
        ).toEqual([carol.id]);
        expect(await friends.searchUsers(alice.id, 'BOB')).toEqual([
          expect.objectContaining({
            id: bob.id,
            relation: FriendRelation.PendingSent,
          }),
        ]);
        expect(await friends.searchUsers(bob.id, 'ali')).toEqual([
          expect.objectContaining({
            id: alice.id,
            relation: FriendRelation.PendingReceived,
          }),
        ]);
        // Jamais soi-même ; `%` est un caractère, pas un joker.
        expect(await friends.searchUsers(alice.id, 'alice')).toEqual([]);
        expect(await friends.searchUsers(alice.id, '%%')).toEqual([]);

        // Dave bloque la demande de Carol : ils ne se trouvent plus.
        const carolToDave = await friends.sendRequest(carol.id, {
          addresseeId: dave.id,
        });
        await friends.updateStatus(
          dave.id,
          carolToDave.id,
          FriendshipStatus.Blocked,
        );
        expect(await friends.searchUsers(carol.id, 'dave')).toEqual([]);
        expect(await friends.searchUsers(dave.id, 'carol')).toEqual([]);
      });
    });

    describe('partages et groupes de lecture', () => {
      beforeEach(async () => {
        const request = await friends.sendRequest(alice.id, {
          addresseeId: bob.id,
        });
        await friends.updateStatus(
          bob.id,
          request.id,
          FriendshipStatus.Accepted,
        );
        await notifications.clear();
      });

      it('partage → manga_share (message lu en direct), pas pour un doublon ; mark-seen → lu', async () => {
        await sharing.shareWithFriends(alice.id, Number(MANGA), {
          friendIds: [bob.id],
          message: 'Tu vas adorer',
        });
        // Même partage encore non vu : ignoré, donc pas de notification.
        await sharing.shareWithFriends(alice.id, Number(MANGA), {
          friendIds: [bob.id],
        });

        const page = await reader.list(bob.id, {});
        expect(page.unreadCount).toBe(1);
        expect(page.items[0]).toMatchObject({
          type: 'manga_share',
          actor: { id: alice.id, username: 'alice', displayName: null },
          manga: {
            muId: Number(MANGA),
            title: 'One Piece',
            coverUrl: 'https://cdn/o.jpg',
          },
          data: { message: 'Tu vas adorer' },
        });

        await expect(sharing.markAllSeen(bob.id)).resolves.toEqual({
          updated: 1,
        });
        expect(await reader.unreadCount(bob.id)).toBe(0);
      });

      it('groupe de lecture → reading_group_invite avec le nom du groupe', async () => {
        await groups.createGroup(alice.id, {
          muId: Number(MANGA),
          inviteFriendIds: [bob.id],
          name: 'Lecture à deux',
        });

        const page = await reader.list(bob.id, {});
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({
          type: 'reading_group_invite',
          actor: { id: alice.id },
          manga: { muId: Number(MANGA) },
          data: { groupName: 'Lecture à deux' },
        });
        expect(
          await ofType(alice.id, NotificationType.ReadingGroupInvite),
        ).toEqual([]);
      });
    });

    describe('lecture, pagination, propriété', () => {
      it('pagine sans trou ni doublon, même avec des dates identiques à la frontière', async () => {
        const at = (iso: string) => new Date(iso);
        await notifications.insert(
          [
            at('2026-10-13T10:00:05.000Z'),
            at('2026-10-13T10:00:04.000Z'),
            at('2026-10-13T10:00:04.000Z'),
            at('2026-10-13T10:00:04.000Z'),
            at('2026-10-13T10:00:01.000Z'),
          ].map((createdAt) => ({
            userId: alice.id,
            type: NotificationType.FriendAccepted,
            data: { friendshipId: 1 },
            createdAt,
          })),
        );

        const seen: string[] = [];
        let before: string | undefined;
        for (let guard = 0; guard < 10; guard += 1) {
          const page = await reader.list(alice.id, { limit: 2, before });
          seen.push(...page.items.map((i) => i.id));
          if (!page.nextBefore) break;
          before = page.nextBefore;
        }
        expect(seen).toHaveLength(5);
        expect(new Set(seen).size).toBe(5);
      });

      it('lecture limitée au propriétaire ; read-all compte les non lues', async () => {
        await producer.friendRequestSent(1, bob.id, alice.id);
        await producer.friendRequestSent(2, carol.id, alice.id);
        const [mine] = await notifications.find({
          where: { userId: alice.id },
        });

        await expect(reader.markRead(bob.id, mine.id)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await expect(reader.markRead(alice.id, mine.id)).resolves.toEqual({
          ok: true,
        });
        // Idempotent.
        await expect(reader.markRead(alice.id, mine.id)).resolves.toEqual({
          ok: true,
        });
        await expect(reader.markAllRead(alice.id)).resolves.toEqual({
          updated: 1,
        });
        expect(await reader.unreadCount(alice.id)).toBe(0);
      });
    });

    describe('RGPD et rétention', () => {
      it('export et résumé incluent les notifications ; compte supprimé → cascade / acteur anonymisé', async () => {
        await producer.friendRequestSent(1, alice.id, bob.id);
        const gdpr = new GdprService(
          ds.getRepository(User),
          ds.getRepository(UserManga),
          ds.getRepository(UserSession),
          ds.getRepository(UserMangaRecommendation),
          notifications,
        );

        const exported = await gdpr.exportUserData(bob.id);
        expect(exported.notifications).toEqual([
          expect.objectContaining({
            type: 'friend_request',
            readAt: null,
            mangaMuId: null,
            data: { friendshipId: 1 },
          }),
        ]);
        expect((await gdpr.getDataSummary(bob.id)).notificationsCount).toBe(1);

        await ds.getRepository(User).delete(alice.id);
        const [orphan] = await notifications.find({
          where: { userId: bob.id },
        });
        expect(orphan.actorId).toBeNull();

        await ds.getRepository(User).delete(bob.id);
        expect(await notifications.count()).toBe(0);
      });

      it('purge les lues de plus de 30 jours et toutes celles de plus de 90 jours', async () => {
        const now = new Date('2026-10-13T03:15:00.000Z');
        const daysAgo = (d: number) =>
          new Date(now.getTime() - d * 24 * 3600 * 1000);
        await notifications.insert([
          {
            userId: alice.id,
            type: NotificationType.FriendAccepted,
            data: {},
            createdAt: daysAgo(31),
            readAt: daysAgo(30),
          },
          {
            userId: alice.id,
            type: NotificationType.FriendAccepted,
            data: {},
            createdAt: daysAgo(31),
            readAt: null,
          },
          {
            userId: alice.id,
            type: NotificationType.FriendAccepted,
            data: {},
            createdAt: daysAgo(91),
            readAt: null,
          },
          {
            userId: alice.id,
            type: NotificationType.FriendAccepted,
            data: {},
            createdAt: daysAgo(2),
            readAt: daysAgo(1),
          },
        ]);

        const retention = new NotificationRetentionService(notifications);
        await expect(retention.purge(now)).resolves.toBe(2);
        expect(await notifications.count()).toBe(2);
      });
    });
  },
);
