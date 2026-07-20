import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { MangaQuickViewDto } from '@/api/mangas/dto/manga-quick-view.dto';
import { RecommendationService } from './recommendation.service';

@ApiTags('Recommendations')
@ApiBearerAuth()
@Controller('recommendations')
export class RecommendationController {
  constructor(private readonly recommendationService: RecommendationService) {}

  @ApiOperation({
    summary:
      "Retourne une liste personnalisée de mangas recommandés pour l'utilisateur connecté",
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Nombre max de recommandations (défaut : 50, max : 500)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Décalage pour la pagination (défaut : 0)',
  })
  @ApiResponse({
    status: 200,
    description: 'Liste de recommandations personnalisées triées par score',
    type: MangaQuickViewDto,
    isArray: true,
  })
  @UseGuards(JwtAuthGuard)
  @Get()
  async getRecommendations(
    @UserDecorator() user: any,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('genre') genre?: string,
  ): Promise<MangaQuickViewDto[]> {
    return this.recommendationService.buildUserRecommendations(
      user.id,
      limit,
      offset,
      genre,
    );
  }

  @ApiOperation({
    summary:
      'Retourne les recommandations regroupées par genre (Action, Romance, Comedy…) pour la home segmentée. Filtre les genres NSFW.',
  })
  @ApiQuery({
    name: 'topGenres',
    required: false,
    type: Number,
    description: 'Nombre max de genres remontés (défaut : 5)',
  })
  @ApiQuery({
    name: 'perGenre',
    required: false,
    type: Number,
    description: 'Nombre max de mangas par genre (défaut : 10)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Map { genre → MangaQuickViewDto[] } avec les genres les plus représentés dans le scoring',
  })
  @UseGuards(JwtAuthGuard)
  @Get('by-genre')
  async getRecommendationsByGenre(
    @UserDecorator() user: any,
    @Query('topGenres', new DefaultValuePipe(5), ParseIntPipe)
    topGenres: number,
    @Query('perGenre', new DefaultValuePipe(10), ParseIntPipe)
    perGenre: number,
  ): Promise<Record<string, MangaQuickViewDto[]>> {
    return this.recommendationService.buildUserRecommendationsByGenre(
      user.id,
      topGenres,
      perGenre,
    );
  }

  @ApiOperation({
    summary:
      "Retourne les 'sleeper hits' : nouveautés récentes (≤ 2 ans) bien notées (≥ 7.5/10) mais peu recommandées par la communauté MangaUpdates. Les pépites cachées.",
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Nombre max de pépites (défaut : 20, max : 500)',
  })
  @ApiResponse({
    status: 200,
    description: 'Liste de pépites récentes triées par score sleeper',
    type: MangaQuickViewDto,
    isArray: true,
  })
  @UseGuards(JwtAuthGuard)
  @Get('sleepers')
  async getSleeperHits(
    @UserDecorator() user: any,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<MangaQuickViewDto[]> {
    return this.recommendationService.findSleeperHits(user.id, limit);
  }
}
