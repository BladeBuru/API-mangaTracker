import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';
import { extractClientIp } from './client-ip.util';

/** Accès typé au membre protégé `getTracker` sans recourir à `any`. */
type TrackerAccess = {
  getTracker(req: Record<string, unknown>): Promise<string>;
};

describe('extractClientIp', () => {
  it('should prefer CF-Connecting-IP (set by Cloudflare) over X-Forwarded-For and req.ip', () => {
    expect(
      extractClientIp({
        headers: {
          'cf-connecting-ip': '203.0.113.7',
          'x-forwarded-for': '198.51.100.1, 172.18.0.2',
        },
        ip: '172.18.0.2',
      }),
    ).toBe('203.0.113.7');
  });

  it('should use the FIRST X-Forwarded-For entry when Cloudflare is not in front', () => {
    expect(
      extractClientIp({
        headers: { 'x-forwarded-for': '198.51.100.1, 172.18.0.2' },
        ip: '172.18.0.2',
      }),
    ).toBe('198.51.100.1');
  });

  it('should fall back to req.ip without proxy headers', () => {
    expect(extractClientIp({ headers: {}, ip: '::1' })).toBe('::1');
    expect(extractClientIp({})).toBe('unknown');
  });

  it('should ignore a header that is not an IP address and try the next source', () => {
    expect(
      extractClientIp({
        headers: {
          'cf-connecting-ip': 'not-an-ip',
          'x-forwarded-for': '2001:db8::1',
        },
        ip: '172.18.0.2',
      }),
    ).toBe('2001:db8::1');
    expect(
      extractClientIp({
        headers: { 'x-forwarded-for': '1.2.3.4:5678' },
        ip: '172.18.0.2',
      }),
    ).toBe('172.18.0.2');
  });

  it('should read the first value of a repeated header', () => {
    expect(
      extractClientIp({
        headers: { 'cf-connecting-ip': ['203.0.113.9', '203.0.113.10'] },
      }),
    ).toBe('203.0.113.9');
  });
});

describe('ClientIpThrottlerGuard', () => {
  it('should track by the real client IP, not the reverse proxy address', async () => {
    const guard = new ClientIpThrottlerGuard([], {} as never, {} as never);
    const tracker = await (guard as unknown as TrackerAccess).getTracker({
      headers: { 'cf-connecting-ip': '203.0.113.7' },
      ip: '172.18.0.2',
    });
    expect(tracker).toBe('203.0.113.7');
  });

  describe('as APP_GUARD (HTTP)', () => {
    @Controller('ping')
    class PingController {
      @Get()
      ping(): { ok: true } {
        return { ok: true };
      }
    }

    let app: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 2 }])],
        controllers: [PingController],
        providers: [{ provide: APP_GUARD, useClass: ClientIpThrottlerGuard }],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    const ping = (clientIp: string) =>
      request(app.getHttpServer())
        .get('/ping')
        .set('CF-Connecting-IP', clientIp);

    it('should give each client its own budget behind the same proxy', async () => {
      await ping('203.0.113.1').expect(200);
      await ping('203.0.113.1').expect(200);
      // Le 3e appel du même client dépasse SON quota…
      await ping('203.0.113.1').expect(429);
      // … sans affecter un autre client derrière le même proxy.
      await ping('203.0.113.2').expect(200);
    });
  });
});
