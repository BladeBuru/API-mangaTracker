import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { UserMangaRecommendation } from './user-manga-recommendation.entity';
import { CommunityController } from './community.controller';
import { CommunityRecommendationService } from './community-recommendation.service';
import { RatingSummaryService } from './rating-summary.service';
import { CommunityThrottlerGuard } from './community-throttler.guard';

/**
 * Module autonome (TypeORM seul) : aucune dépendance vers `MangasModule`,
 * donc aucun risque de cycle. La note globale réutilise la fonction pure
 * `aggregateRating`, pas le service des mangas.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Manga,
      MangaRecommendation,
      UserManga,
      UserMangaRecommendation,
    ]),
  ],
  controllers: [CommunityController],
  providers: [
    CommunityRecommendationService,
    RatingSummaryService,
    CommunityThrottlerGuard,
  ],
  exports: [CommunityRecommendationService],
})
export class CommunityModule {}
