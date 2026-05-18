import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import User from '@/api/user/user.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/**
 * Module statistiques utilisateur (Phase 2). Expose `/user/stats` (JWT).
 *
 * Dépend uniquement des entités déjà existantes — aucune migration de
 * schéma sauf l'ajout de `User.createdAt` (migration 1746230900000).
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, UserManga])],
  controllers: [StatsController],
  providers: [StatsService],
  exports: [StatsService],
})
export class StatsModule {}
