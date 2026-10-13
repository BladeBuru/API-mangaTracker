import {
  CanActivate,
  Controller,
  ExecutionContext,
  INestApplication,
  Injectable,
  Post,
  Type,
  UseGuards,
} from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';
import { UserScopedThrottlerGuard } from '@/api/library/user-scoped-throttler.guard';
import { FriendRequestThrottlerGuard } from '@/api/friends/friend-request-throttler.guard';
import { CommentWriteThrottlerGuard } from '@/api/comments/comment-write-throttler.guard';
import { ReadingGroupWriteThrottlerGuard } from '@/api/sharing/reading-group-write-throttler.guard';
import { MangaShareThrottlerGuard } from '@/api/sharing/manga-share-throttler.guard';
import { FriendsController } from '@/api/friends/friends.controller';
import { CommentsController } from '@/api/comments/comments.controller';
import { SharingController } from '@/api/sharing/sharing.controller';
import { ReadingGroupsController } from '@/api/sharing/reading-groups.controller';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';

/** Accès typé aux membres protégés du garde, sans `any`. */
type GuardInternals = {
  getTracker(req: Record<string, unknown>): Promise<string>;
  throttlers: Array<{ name: string; ttl: number; limit: number }>;
};

type GuardClass = Type<UserScopedThrottlerGuard> & {
  WINDOW_MS: number;
  LIMIT: number;
  THROTTLER_NAME: string;
};

const CASES: Array<[string, GuardClass, number, number]> = [
  ['FriendRequestThrottlerGuard', FriendRequestThrottlerGuard, 60_000, 5],
  ['CommentWriteThrottlerGuard', CommentWriteThrottlerGuard, 3_600_000, 10],
  [
    'ReadingGroupWriteThrottlerGuard',
    ReadingGroupWriteThrottlerGuard,
    60_000,
    10,
  ],
  ['MangaShareThrottlerGuard', MangaShareThrottlerGuard, 60_000, 30],
];

describe.each(CASES)('%s', (_name, GuardCls, ttl, limit) => {
  let guard: GuardInternals;

  beforeEach(async () => {
    const instance = new GuardCls([], {} as never, {} as never);
    await instance.onModuleInit();
    guard = instance as unknown as GuardInternals;
  });

  it('should keep the historical quota, in a dedicated named throttler', () => {
    expect(guard.throttlers).toEqual([
      { name: GuardCls.THROTTLER_NAME, ttl, limit },
    ]);
    expect(GuardCls.THROTTLER_NAME).not.toBe('default');
  });

  it('should track per authenticated user, not per proxy IP', async () => {
    await expect(
      guard.getTracker({ user: { id: 42 }, ip: '172.18.0.2' }),
    ).resolves.toBe('user-42');
  });

  it('should fall back to the real client IP when no user is set', async () => {
    // Arrivée par Cloudflare : edge (162.158.0.0/15) ajouté par NPMplus.
    await expect(
      guard.getTracker({
        headers: {
          'cf-connecting-ip': '203.0.113.5',
          'x-forwarded-for': '203.0.113.5, 162.158.1.2',
        },
        ip: '172.18.0.2',
      }),
    ).resolves.toBe('203.0.113.5');
  });
});

describe('Routes d’écriture sociales — câblage du quota par utilisateur', () => {
  const routes: Array<[string, object, string, GuardClass]> = [
    [
      'POST /friends/request',
      FriendsController,
      'request',
      FriendRequestThrottlerGuard,
    ],
    [
      'POST /mangas/:muId/comments',
      CommentsController,
      'create',
      CommentWriteThrottlerGuard,
    ],
    [
      'POST /mangas/comments/:id/reply',
      CommentsController,
      'reply',
      CommentWriteThrottlerGuard,
    ],
    [
      'POST /mangas/comments/:id/report',
      CommentsController,
      'report',
      CommentWriteThrottlerGuard,
    ],
    [
      'POST /sharing/manga/:muId',
      SharingController,
      'shareManga',
      MangaShareThrottlerGuard,
    ],
    [
      'POST /reading-groups',
      ReadingGroupsController,
      'create',
      ReadingGroupWriteThrottlerGuard,
    ],
    [
      'POST /reading-groups/:id/invite',
      ReadingGroupsController,
      'invite',
      ReadingGroupWriteThrottlerGuard,
    ],
  ];

  it.each(routes)(
    '%s should use its per-user guard and no IP-based @Throttle override',
    (_route, controller, method, GuardCls) => {
      const handler = (controller as { prototype: Record<string, unknown> })
        .prototype[method] as object;
      const guards: unknown[] =
        Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
      expect(guards).toContain(GuardCls);
      // L'ancien `@Throttle({ default })` (tracké par IP) a disparu.
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(
        undefined,
      );
    },
  );

  it('should answer 200 (not 201) on mark-seen and comment report', () => {
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        SharingController.prototype.markSeen,
      ),
    ).toBe(200);
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        CommentsController.prototype.report,
      ),
    ).toBe(200);
  });
});

describe('Quota par utilisateur (HTTP)', () => {
  /** Simule `JwtAuthGuard` : l'utilisateur vient de l'en-tête `x-user`. */
  @Injectable()
  class FakeJwtGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest();
      req.user = { id: Number(req.headers['x-user']) };
      return true;
    }
  }

  @Controller('friends')
  class FakeFriendsController {
    @UseGuards(FakeJwtGuard, FriendRequestThrottlerGuard)
    @Post('request')
    request(): { ok: true } {
      return { ok: true };
    }
  }

  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [FakeFriendsController],
      providers: [
        { provide: APP_GUARD, useClass: ClientIpThrottlerGuard },
        FakeJwtGuard,
        FriendRequestThrottlerGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Tous les appels passent par le même proxy et la même IP client. */
  const send = (userId: number) =>
    request(app.getHttpServer())
      .post('/friends/request')
      .set('CF-Connecting-IP', '203.0.113.1')
      .set('x-user', String(userId));

  it('should cut one user at 5/min without affecting another user on the same IP', async () => {
    for (let i = 0; i < 5; i += 1) {
      await send(1).expect(201);
    }
    await send(1).expect(429);
    await send(2).expect(201);
  });
});
