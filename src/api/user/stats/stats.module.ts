import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import User from '@/api/user/user.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { UserMangaChapterLog } from '@/api/library/user-manga-chapter-log.entity';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

/**
 * Module statistiques utilisateur (Phase 2, enrichi Stats v2). Expose
 * `/user/stats` (JWT).
 *
 * Stats v2 : consomme aussi le journal `user_manga_chapter_log` pour
 * l'historique des lectures et l'activité hebdomadaire.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User, UserManga, UserMangaChapterLog])],
  controllers: [StatsController],
  providers: [StatsService],
  exports: [StatsService],
})
export class StatsModule {}
