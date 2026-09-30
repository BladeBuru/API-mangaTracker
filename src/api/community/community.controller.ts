import { Controller, Delete, Get, Param, Put, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { ParseMuIdPipe } from '@/shared/pipes/parse-mu-id.pipe';
import User from '@/api/user/user.entity';
import { CommunityRecommendationService } from './community-recommendation.service';
import { RatingSummaryService } from './rating-summary.service';
import { CommunityThrottlerGuard } from './community-throttler.guard';
import {
  CommunityRecommendationItemDto,
  CommunityRecommendationsDto,
  RatingSummaryDto,
} from './dto/community-recommendation.dto';

/**
 * Contributions de la communauté Manga Tracker sur une œuvre : synthèse des
 * notes (MangaUpdates + utilisateurs) et recommandations « si vous avez aimé
 * ceci, lisez cela ». Routes à deux segments (`/mangas/:muId/…`) : aucun
 * conflit avec `GET /mangas/:id`.
 */
@ApiTags('Communauté')
@ApiBearerAuth()
@Controller('mangas')
@UseGuards(JwtAuthGuard)
export class CommunityController {
  constructor(
    private readonly recommendations: CommunityRecommendationService,
    private readonly ratings: RatingSummaryService,
  ) {}

  @ApiOperation({
    summary: 'Note globale (MangaUpdates + Manga Tracker) et total des votes',
  })
  @ApiResponse({ status: 200, type: RatingSummaryDto })
  @ApiResponse({ status: 404, description: 'Manga inconnu' })
  @Get(':muId/ratings')
  ratingSummary(
    @Param('muId', ParseMuIdPipe) muId: number,
  ): Promise<RatingSummaryDto> {
    return this.ratings.getSummary(muId);
  }

  @ApiOperation({
    summary:
      'Recommandations de la fiche : votes MangaUpdates + votes Manga Tracker',
  })
  @ApiResponse({ status: 200, type: CommunityRecommendationsDto })
  @Get(':muId/community-recommendations')
  list(
    @Param('muId', ParseMuIdPipe) muId: number,
    @UserDecorator() user: User,
  ): Promise<CommunityRecommendationsDto> {
    return this.recommendations.list(muId, user.id);
  }

  @ApiOperation({
    summary: 'Recommander une œuvre à qui a aimé celle-ci (idempotent)',
  })
  @ApiResponse({ status: 200, type: CommunityRecommendationItemDto })
  @ApiResponse({ status: 400, description: 'Œuvre recommandée pour elle-même' })
  @ApiResponse({
    status: 404,
    description: 'Œuvre source inconnue, ou cible inconnue de MangaUpdates',
  })
  @ApiResponse({ status: 429, description: 'Trop de votes (60 / heure)' })
  @Put(':muId/community-recommendations/:targetMuId')
  @UseGuards(CommunityThrottlerGuard)
  recommend(
    @Param('muId', ParseMuIdPipe) muId: number,
    @Param('targetMuId', ParseMuIdPipe) targetMuId: number,
    @UserDecorator() user: User,
  ): Promise<CommunityRecommendationItemDto> {
    // Pas de corps : une œuvre inconnue est créée d'après MangaUpdates,
    // jamais d'après un titre envoyé par l'application (les anciennes
    // versions en envoient un ; non lu, donc sans effet).
    return this.recommendations.recommend(user.id, muId, targetMuId);
  }

  @ApiOperation({ summary: 'Retirer sa recommandation' })
  @ApiResponse({ status: 200, type: CommunityRecommendationItemDto })
  @Delete(':muId/community-recommendations/:targetMuId')
  @UseGuards(CommunityThrottlerGuard)
  unrecommend(
    @Param('muId', ParseMuIdPipe) muId: number,
    @Param('targetMuId', ParseMuIdPipe) targetMuId: number,
    @UserDecorator() user: User,
  ): Promise<CommunityRecommendationItemDto> {
    return this.recommendations.unrecommend(user.id, muId, targetMuId);
  }
}
