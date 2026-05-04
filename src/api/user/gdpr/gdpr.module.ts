import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import User from '@/api/user/user.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { UserSession } from '@/api/user/auth/user-session.entity';
import { GdprController } from './gdpr.controller';
import { GdprService } from './gdpr.service';

/**
 * Module RGPD : centralise les endpoints du droit d'accès, droit à la
 * portabilité et gestion du consentement éclairé.
 *
 * Découplé du UserModule pour faciliter l'audit (un seul endroit où sont
 * définies les opérations sensibles sur les données personnelles).
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, UserManga, UserSession])],
  controllers: [GdprController],
  providers: [GdprService],
  exports: [GdprService],
})
export class GdprModule {}
