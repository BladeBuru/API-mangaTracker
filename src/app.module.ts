import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { getEnvPath } from './common/helper/env.helper';
import { TypeOrmConfigService } from './shared/typeorm/typeorm.service';
import { ApiModule } from './api/api.module';
import { HealthModule } from './health/health.module';
import { ClientIpThrottlerGuard } from './shared/throttling/client-ip-throttler.guard';

const envFilePath: string = getEnvPath(`${__dirname}/common/envs`);

@Module({
  imports: [
    ConfigModule.forRoot({ envFilePath, isGlobal: true }),
    TypeOrmModule.forRootAsync({ useClass: TypeOrmConfigService }),
    // Rate limiting global : 100 req/min par IP CLIENT par défaut (IP réelle
    // lue par `ClientIpThrottlerGuard`, pas celle du reverse proxy).
    // Les endpoints sensibles (auth, email) overrident avec @Throttle()
    // pour des limites plus strictes (5–10 req/min) ; les écritures
    // authentifiées ont en plus un quota par utilisateur.
    // Cf. CLAUDE.md « Sécurité non-négociable ».
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    // Crons applicatifs (sync nightly du catalogue MU — CatalogSyncService).
    ScheduleModule.forRoot(),
    ApiModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ClientIpThrottlerGuard },
  ],
})
export class AppModule {}
