# `main.ts` — Sécurité bootstrap

> Snippet injecté automatiquement quand vous éditez `main.ts`.

`main.ts` est le point d'entrée. **Toute config sécurité doit y figurer**.

## Checklist obligatoire

- [ ] **Helmet** installé et appliqué globalement (`app.use(helmet())`).
- [ ] **Throttler** (`@nestjs/throttler`) configuré globalement avec un guard `ThrottlerGuard`.
- [ ] **CORS** avec **whitelist explicite** par environnement (dev / prod / staging) — jamais `app.enableCors()` nu.
- [ ] **ValidationPipe** global : `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`, `forbidUnknownValues: true`.
- [ ] Swagger **désactivé en production** ou protégé par auth.
- [ ] Pas de `console.log` ou de stack trace exposé via les exceptions par défaut.
- [ ] Port lu via `process.env.PORT` avec fallback `3000`.

## Template recommandé

```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 1. Helmet — security headers
  app.use(helmet());

  // 2. CORS — whitelist par environnement
  const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    credentials: true,
  });

  // 3. Validation stricte
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      stopAtFirstError: false,
    }),
  );

  // 4. Swagger uniquement hors production (ou auth-protected)
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Manga Tracker API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api', app, SwaggerModule.createDocument(app, config));
  }

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

## Throttler — config globale

Dans `app.module.ts` :

```typescript
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]), // 100 req/min global
    // ...
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // ...
  ],
})
export class AppModule {}
```

Et sur les endpoints sensibles (`AuthController`) :

```typescript
import { Throttle } from '@nestjs/throttler';

@Throttle({ default: { ttl: 60_000, limit: 5 } }) // 5 req/min sur /auth/login
@Post('login')
login(@Body() dto: LoginDto) { ... }
```

## CORS_ORIGINS par environnement

```env
# .env.development
CORS_ORIGINS=http://localhost:3000,http://localhost:8080

# .env.production
CORS_ORIGINS=https://app.manga-tracker.com,https://manga-tracker.com
```
