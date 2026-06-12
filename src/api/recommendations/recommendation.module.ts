import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { MangasModule } from '@/api/mangas/mangas.module';
import { RecommendationService } from './recommendation.service';
import { RecommendationController } from './recommendation.controller';
import { RecoCacheService } from './reco-cache.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserManga, MangaRecommendation, Manga]),
    MangasModule,
  ],
  controllers: [RecommendationController],
  providers: [RecommendationService, RecoCacheService],
  // RecoCacheService exporté : LibraryModule invalide le cache d'un user
  // quand sa bibliothèque change (hotfix-v0-10-1 US-4).
  exports: [RecommendationService, RecoCacheService],
})
export class RecommendationModule {}
