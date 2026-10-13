import {
  ExecutionContext,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Tests HTTP du contrat (codes, validation, routage) : le service est
 * simulé, l'authentification remplacée par un utilisateur fixe (id 1).
 * Le `ValidationPipe` reprend la configuration de `main.ts`.
 */
describe('NotificationsController (HTTP)', () => {
  let app: INestApplication;
  let service: {
    list: jest.Mock;
    unreadCount: jest.Mock;
    markRead: jest.Mock;
    markAllRead: jest.Mock;
  };
  const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  beforeAll(async () => {
    service = {
      list: jest.fn(),
      unreadCount: jest.fn(),
      markRead: jest.fn(),
      markAllRead: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().user = { id: 1 };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        whitelist: true,
        forbidNonWhitelisted: true,
        forbidUnknownValues: true,
        stopAtFirstError: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  it('GET /notifications → 200 with the page of the current user', async () => {
    const page = { items: [], unreadCount: 0, nextBefore: null };
    service.list.mockResolvedValue(page);

    const res = await request(app.getHttpServer())
      .get('/notifications')
      .query({ limit: '10', before: '2026-10-13T10:00:00.000Z' })
      .expect(200);

    expect(res.body).toEqual(page);
    expect(service.list).toHaveBeenCalledWith(1, {
      limit: 10,
      before: '2026-10-13T10:00:00.000Z',
    });
  });

  it('GET /notifications → 400 on an invalid limit or before', async () => {
    await request(app.getHttpServer())
      .get('/notifications?limit=0')
      .expect(400);
    await request(app.getHttpServer())
      .get('/notifications?before=hier')
      .expect(400);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('GET /notifications/unread-count → 200 { count }', async () => {
    service.unreadCount.mockResolvedValue(3);

    const res = await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .expect(200);

    expect(res.body).toEqual({ count: 3 });
    expect(service.unreadCount).toHaveBeenCalledWith(1);
  });

  it('POST /notifications/:id/read → 200 { ok: true } (not 201)', async () => {
    service.markRead.mockResolvedValue({ ok: true });

    const res = await request(app.getHttpServer())
      .post(`/notifications/${uuid}/read`)
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(service.markRead).toHaveBeenCalledWith(1, uuid);
  });

  it('POST /notifications/:id/read → 404 for a foreign, unknown or malformed id', async () => {
    service.markRead.mockRejectedValue(new NotFoundException());

    await request(app.getHttpServer())
      .post(`/notifications/${uuid}/read`)
      .expect(404);
    await request(app.getHttpServer())
      .post('/notifications/pas-un-uuid/read')
      .expect(404);
    expect(service.markRead).toHaveBeenCalledTimes(1);
  });

  it('POST /notifications/read-all → 200 { updated } (not 201)', async () => {
    service.markAllRead.mockResolvedValue({ updated: 2 });

    const res = await request(app.getHttpServer())
      .post('/notifications/read-all')
      .expect(200);

    expect(res.body).toEqual({ updated: 2 });
    expect(service.markAllRead).toHaveBeenCalledWith(1);
  });
});
