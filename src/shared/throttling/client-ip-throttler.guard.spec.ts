import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';
import { ClientIpThrottlerGuard } from './client-ip-throttler.guard';
import {
  extractClientIp,
  isCloudflareAddress,
  normalizeIp,
} from './client-ip.util';

/** Accès typé au membre protégé `getTracker` sans recourir à `any`. */
type TrackerAccess = {
  getTracker(req: Record<string, unknown>): Promise<string>;
};

/** Adresse de NPMplus vue par le conteneur (réseau Docker). */
const NPMPLUS = '172.18.0.2';
/** Un edge Cloudflare (162.158.0.0/15). */
const CF_EDGE = '162.158.1.2';
const CLIENT = '203.0.113.7';
const ATTACKER = '198.51.100.66';

describe('normalizeIp', () => {
  it('should strip spaces, ports and the IPv4-mapped prefix', () => {
    expect(normalizeIp(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(normalizeIp('203.0.113.7:443')).toBe('203.0.113.7');
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('should reject anything that is not an IP address', () => {
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });
});

describe('isCloudflareAddress', () => {
  it('should match the published Cloudflare IPv4 and IPv6 ranges only', () => {
    expect(isCloudflareAddress('162.158.1.2')).toBe(true);
    expect(isCloudflareAddress('104.23.255.255')).toBe(true); // fin de 104.16.0.0/13
    expect(isCloudflareAddress('104.27.255.255')).toBe(true); // fin de 104.24.0.0/14
    expect(isCloudflareAddress('104.28.0.1')).toBe(false);
    expect(isCloudflareAddress('2606:4700::6810:84e5')).toBe(true);
    expect(isCloudflareAddress('2a06:98c7:ffff::1')).toBe(true); // /29
    expect(isCloudflareAddress('2a06:98c8::1')).toBe(false);
    expect(isCloudflareAddress(ATTACKER)).toBe(false);
    expect(isCloudflareAddress(NPMPLUS)).toBe(false);
  });
});

describe('extractClientIp', () => {
  it('should use CF-Connecting-IP when the proxy peer is a Cloudflare edge', () => {
    // Client → Cloudflare → NPMplus : NPMplus a ajouté l'edge en fin de liste.
    expect(
      extractClientIp({
        headers: {
          'cf-connecting-ip': CLIENT,
          'x-forwarded-for': `${CLIENT}, ${CF_EDGE}`,
        },
        ip: NPMPLUS,
      }),
    ).toBe(CLIENT);
  });

  it('should ignore a forged CF-Connecting-IP from a direct (non-Cloudflare) peer', () => {
    // Attaquant → NPMplus en direct : seul le dernier saut est fiable.
    expect(
      extractClientIp({
        headers: {
          'cf-connecting-ip': '1.1.1.1',
          'x-forwarded-for': `9.9.9.9, ${ATTACKER}`,
        },
        ip: NPMPLUS,
      }),
    ).toBe(ATTACKER);
  });

  it('should ignore a forged X-Forwarded-For prefix posing as a Cloudflare edge', () => {
    expect(
      extractClientIp({
        headers: {
          'cf-connecting-ip': '1.1.1.1',
          'x-forwarded-for': `${CF_EDGE}, ${ATTACKER}`,
        },
        ip: NPMPLUS,
      }),
    ).toBe(ATTACKER);
  });

  it('should handle IPv6 through Cloudflare and IPv6 direct peers', () => {
    expect(
      extractClientIp({
        headers: {
          'cf-connecting-ip': '2001:db8::1',
          'x-forwarded-for': '2001:db8::1, 2a06:98c0::5',
        },
        ip: NPMPLUS,
      }),
    ).toBe('2001:db8::1');
    expect(
      extractClientIp({
        headers: {
          'cf-connecting-ip': '2001:db8::1',
          'x-forwarded-for': '[2001:db8::bad]:443',
        },
        ip: NPMPLUS,
      }),
    ).toBe('2001:db8::bad');
  });

  it('should normalise ::ffff: mapped addresses (peer and CF-Connecting-IP)', () => {
    expect(
      extractClientIp({
        headers: {
          'cf-connecting-ip': `::ffff:${CLIENT}`,
          'x-forwarded-for': `::ffff:${CF_EDGE}`,
        },
        ip: NPMPLUS,
      }),
    ).toBe(CLIENT);
    expect(extractClientIp({ headers: {}, ip: `::ffff:${NPMPLUS}` })).toBe(
      NPMPLUS,
    );
  });

  it('should fall back to the edge itself when Cloudflare sends no valid CF-Connecting-IP', () => {
    expect(
      extractClientIp({
        headers: { 'x-forwarded-for': CF_EDGE, 'cf-connecting-ip': 'junk' },
        ip: NPMPLUS,
      }),
    ).toBe(CF_EDGE);
  });

  it('should use req.ip without X-Forwarded-For, even with a forged CF header', () => {
    expect(
      extractClientIp({
        headers: { 'cf-connecting-ip': '1.1.1.1' },
        ip: '::1',
      }),
    ).toBe('::1');
    expect(extractClientIp({ headers: {}, ip: '::1' })).toBe('::1');
    expect(extractClientIp({})).toBe('unknown');
  });

  it('should read repeated headers (arrays) and keep the LAST forwarded hop', () => {
    expect(
      extractClientIp({
        headers: {
          'cf-connecting-ip': [CLIENT, '203.0.113.10'],
          'x-forwarded-for': ['9.9.9.9', CF_EDGE],
        },
        ip: NPMPLUS,
      }),
    ).toBe(CLIENT);
  });
});

describe('ClientIpThrottlerGuard', () => {
  it('should track by the real client IP, not the reverse proxy address', async () => {
    const guard = new ClientIpThrottlerGuard([], {} as never, {} as never);
    const tracker = await (guard as unknown as TrackerAccess).getTracker({
      headers: {
        'cf-connecting-ip': CLIENT,
        'x-forwarded-for': `${CLIENT}, ${CF_EDGE}`,
      },
      ip: NPMPLUS,
    });
    expect(tracker).toBe(CLIENT);
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

    /** Requête arrivée par Cloudflare (edge ajouté par NPMplus). */
    const viaCloudflare = (clientIp: string) =>
      request(app.getHttpServer())
        .get('/ping')
        .set('CF-Connecting-IP', clientIp)
        .set('X-Forwarded-For', `${clientIp}, ${CF_EDGE}`);

    /** Requête directe sur l'origine, en-têtes Cloudflare forgés. */
    const forged = (fakeIp: string) =>
      request(app.getHttpServer())
        .get('/ping')
        .set('CF-Connecting-IP', fakeIp)
        .set('X-Forwarded-For', `${fakeIp}, ${ATTACKER}`);

    it('should give each Cloudflare client its own budget behind the same proxy', async () => {
      await viaCloudflare('203.0.113.1').expect(200);
      await viaCloudflare('203.0.113.1').expect(200);
      // Le 3e appel du même client dépasse SON quota…
      await viaCloudflare('203.0.113.1').expect(429);
      // … sans affecter un autre client derrière le même proxy.
      await viaCloudflare('203.0.113.2').expect(200);
    });

    it('should not let a direct caller escape its quota by rotating forged headers', async () => {
      await forged('10.0.0.1').expect(200);
      await forged('10.0.0.2').expect(200);
      await forged('10.0.0.3').expect(429);
    });
  });
});
