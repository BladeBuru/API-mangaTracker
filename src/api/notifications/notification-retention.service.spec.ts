import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Notification } from './notification.entity';
import { NotificationRetentionService } from './notification-retention.service';

describe('NotificationRetentionService', () => {
  let service: NotificationRetentionService;
  let qb: Record<string, jest.Mock>;

  beforeEach(async () => {
    qb = {};
    for (const method of ['delete', 'from', 'where']) {
      qb[method] = jest.fn().mockReturnValue(qb);
    }
    qb.execute = jest.fn().mockResolvedValue({ affected: 5 });
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationRetentionService,
        {
          provide: getRepositoryToken(Notification),
          useValue: { createQueryBuilder: jest.fn(() => qb) },
        },
      ],
    }).compile();
    service = moduleRef.get(NotificationRetentionService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('should delete read notifications older than 30 days and any older than 90 days', async () => {
    const now = new Date('2026-10-13T03:15:00.000Z');

    await expect(service.purge(now)).resolves.toBe(5);

    const [clause, params] = qb.where.mock.calls[0];
    expect(clause).toBe(
      '("read_at" IS NOT NULL AND "created_at" < :readCutoff) OR "created_at" < :maxCutoff',
    );
    expect(params.readCutoff.toISOString()).toBe('2026-09-13T03:15:00.000Z');
    expect(params.maxCutoff.toISOString()).toBe('2026-07-15T03:15:00.000Z');
  });

  it('should swallow a database error (retried the next night)', async () => {
    qb.execute.mockRejectedValue(new Error('db down'));

    await expect(service.purge()).resolves.toBe(0);
    expect(Logger.prototype.error).toHaveBeenCalled();
  });
});
