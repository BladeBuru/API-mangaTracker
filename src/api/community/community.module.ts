import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MangasModule } from '@/api/mangas/mangas.module';
import { Manga } from '@/api/mangas/manga.entity';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { UserMangaRecommendation } from './user-manga-recommendation.entity';
import { CommunityController } from './community.controller';
import { CommunityRecommendationService } from './community-recommendation.service';
import { RatingSummaryService } from './rating-summary.service';
import { CommunityThrottlerGuard } from './community-throttler.guard';

/**
 * Dépend de `MangasModule` uniquement pour créer, d'après MangaUpdates, une
 * œuvre recommandée pas encore en base (`MangasService.getMangaDetails`).
 * `MangasModule` n'importe pas ce module : pas de cycle. La note globale
 * réutilise la fonction pure `aggregateRating`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Manga,
      MangaRecommendation,
      UserManga,
      UserMangaRecommendation,
    ]),
    MangasModule,
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
