import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import User from '@/api/user/user.entity';
import { CommunityRecommendationService } from './community-recommendation.service';
import { RatingSummaryService } from './rating-summary.service';
import { CommunityThrottlerGuard } from './community-throttler.guard';
import {
  CommunityRecommendationItemDto,
  CommunityRecommendationsDto,
  RatingSummaryDto,
  RecommendMangaDto,
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
    @Param('muId', ParseIntPipe) muId: number,
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
    @Param('muId', ParseIntPipe) muId: number,
    @UserDecorator() user: User,
  ): Promise<CommunityRecommendationsDto> {
    return this.recommendations.list(muId, user.id);
  }

  @ApiOperation({
    summary: 'Recommander une œuvre à qui a aimé celle-ci (idempotent)',
  })
  @ApiResponse({ status: 200, type: CommunityRecommendationItemDto })
  @ApiResponse({ status: 400, description: 'Œuvre recommandée pour elle-même' })
  @ApiResponse({ status: 404, description: 'Œuvre source inconnue' })
  @ApiResponse({ status: 429, description: 'Trop de votes (60 / heure)' })
  @Put(':muId/community-recommendations/:targetMuId')
  @UseGuards(CommunityThrottlerGuard)
  recommend(
    @Param('muId', ParseIntPipe) muId: number,
    @Param('targetMuId', ParseIntPipe) targetMuId: number,
    @Body() body: RecommendMangaDto,
    @UserDecorator() user: User,
  ): Promise<CommunityRecommendationItemDto> {
    return this.recommendations.recommend(
      user.id,
      muId,
      targetMuId,
      body?.title,
    );
  }

  @ApiOperation({ summary: 'Retirer sa recommandation' })
  @ApiResponse({ status: 200, type: CommunityRecommendationItemDto })
  @Delete(':muId/community-recommendations/:targetMuId')
  @UseGuards(CommunityThrottlerGuard)
  unrecommend(
    @Param('muId', ParseIntPipe) muId: number,
    @Param('targetMuId', ParseIntPipe) targetMuId: number,
    @UserDecorator() user: User,
  ): Promise<CommunityRecommendationItemDto> {
    return this.recommendations.unrecommend(user.id, muId, targetMuId);
  }
}
