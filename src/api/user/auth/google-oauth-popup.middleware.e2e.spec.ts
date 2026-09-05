import {
  Controller,
  Get,
  INestApplication,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
  Res,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Response } from 'express';
import helmet from 'helmet';
import * as request from 'supertest';
import { GoogleOAuthPopupMiddleware } from './google-oauth-popup.middleware';

/**
 * Reproduit le câblage réel (Helmet global posé dans `main.ts` AVANT
 * `listen()`, middleware de module appliqué à `GET auth/google` et
 * `GET auth/google/callback`) sans base de données ni Passport, et vérifie
 * l'en-tête effectivement renvoyé — y compris sur une redirection 302,
 * qui est ce que Passport produit sur `/auth/google`.
 */
@Controller('auth')
class FakeAuthController {
  @Get('google')
  google(@Res() res: Response): void {
    res.redirect('https://accounts.google.com/o/oauth2/v2/auth');
  }

  @Get('google/callback')
  callback(@Res() res: Response): void {
    res.send('<!DOCTYPE html><p>ok</p>');
  }

  @Get('login')
  login(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [FakeAuthController] })
class FakeAuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(GoogleOAuthPopupMiddleware)
      .forRoutes(
        { path: 'auth/google', method: RequestMethod.GET },
        { path: 'auth/google/callback', method: RequestMethod.GET },
      );
  }
}

describe('GoogleOAuthPopupMiddleware (câblage réel avec Helmet)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeAuthModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use(helmet());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should send unsafe-none on the 302 of GET /auth/google', async () => {
    const res = await request(app.getHttpServer()).get('/auth/google');
    expect(res.status).toBe(302);
    expect(res.headers['cross-origin-opener-policy']).toBe('unsafe-none');
  });

  it('should send unsafe-none on GET /auth/google/callback', async () => {
    const res = await request(app.getHttpServer()).get('/auth/google/callback');
    expect(res.status).toBe(200);
    expect(res.headers['cross-origin-opener-policy']).toBe('unsafe-none');
  });

  it('should keep Helmet strict COOP on every other route', async () => {
    const res = await request(app.getHttpServer()).get('/auth/login');
    expect(res.status).toBe(200);
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
  });
});
