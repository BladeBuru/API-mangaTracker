import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MangaQuickViewDto } from './dto/manga-quick-view.dto';
import { MangasService } from './mangas.service';
import { RetrieveMangaTrendsInternalDto } from './dto/retrieve-manga-trends-internal.dto';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { SearchMangaDto } from './dto/search-manga.dto';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { LibraryService } from '@/api/library/library.service';

@ApiTags('Mangas')
@ApiBearerAuth()
@Controller('mangas')
export class MangasController {
  constructor(
    private readonly mangasService: MangasService,
    private readonly libraryService: LibraryService,
  ) {}

  @ApiOperation({
    summary: 'Retrieve the popular mangas according to their rating',
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 200,
    description:
      'Request has been validated. Retrieve the popular mangas according to their rating',
    type: MangaQuickViewDto,
  })
  @UseGuards(JwtAuthGuard)
  @Get('popular')
  async top(
    @Query()
    filters: RetrieveMangaTrendsInternalDto,
  ): Promise<MangaQuickViewDto[]> {
    return this.mangasService.retrieveManga(
      'rating',
      filters.limit,
      filters.offset,
    );
  }

  @ApiOperation({
    summary: 'Retrieve mangas according to their year of release',
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 200,
    description:
      'Request has been validated. Retrieve mangas according to their year of release',
    type: MangaQuickViewDto,
  })
  @UseGuards(JwtAuthGuard)
  @Get('new')
  async new(
    @Query()
    filters: RetrieveMangaTrendsInternalDto,
  ): Promise<MangaQuickViewDto[]> {
    return this.mangasService.retrieveManga(
      'year',
      filters.limit,
      filters.offset,
    );
  }

  @ApiOperation({
    summary:
      'Retrieve mangas according to their position in the weekly ranking',
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 200,
    description:
      'Request has been validated. Retrieve mangas according to their position in the weekly ranking',
    type: MangaQuickViewDto,
  })
  @UseGuards(JwtAuthGuard)
  @Get('trending')
  async trending(
    @Query()
    filters: RetrieveMangaTrendsInternalDto,
  ): Promise<MangaQuickViewDto[]> {
    return this.mangasService.retrieveManga(
      'week_pos',
      filters.limit,
      filters.offset,
    );
  }

  @ApiOperation({
    summary:
      'Retourne les mangas recommandés par la communauté pour un manga donné',
  })
  @ApiResponse({
    status: 200,
    description: 'Liste des recommandations communautaires (MangaQuickViewDto)',
    type: MangaQuickViewDto,
    isArray: true,
  })
  @UseGuards(JwtAuthGuard)
  @Get('recommendations/:muId')
  async mangaRecommendations(
    @Param('muId', ParseIntPipe) muId: number,
  ): Promise<MangaQuickViewDto[]> {
    return this.mangasService.getRecommendationsAsQuickView(muId);
  }

  @ApiOperation({
    summary: 'Get details of the manga with given id',
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 200,
    description: 'Request has been validated. Get the manga with given id',
    type: MangaDetailsDto,
  })
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async mangaDetails(
    @Param('id', ParseIntPipe) id: number,
    @UserDecorator() user: any,
  ): Promise<MangaDetailsDto> {
    const mangaDetails = await this.mangasService.getMangaDetails(id);
    let customLink: string | undefined = undefined;
    let inLibrary = false;
    let readChaptersCount: number | undefined = undefined;
    let userRating: number | undefined = undefined;
    if (user && user.id) {
      const userManga = await this.libraryService.getUserManga(user.id, id);
      if (userManga) {
        customLink = userManga.custom_link ?? undefined;
        inLibrary = true;
        readChaptersCount = userManga.user_read_chapters;
        userRating = userManga.user_rating ?? 0;
      }
    }

    // Enrichir avec la note communautaire agrégée (Bayesian)
    const muIds = [id.toString()];
    const muRatings = new Map([
      [id.toString(), Number(mangaDetails.rating) || 0],
    ]);
    const community = await this.mangasService.getCommunityRatings(
      muIds,
      muRatings,
    );
    const c = community.get(id.toString());

    return {
      ...mangaDetails,
      custom_link: customLink,
      in_library: inLibrary,
      read_chapters_count: readChaptersCount,
      user_rating: userRating,
      community_rating: c?.communityRating ?? undefined,
      community_rating_count: c?.communityRatingCount ?? 0,
      aggregated_rating: c?.aggregatedRating ?? undefined,
    };
  }

  @ApiOperation({ summary: 'Search for mangas matching the given pattern' })
  @ApiResponse({
    status: 200,
    description: 'Return an array of mangas matching the given pattern',
    type: MangaQuickViewDto,
  })
  @ApiResponse({ status: 403, description: 'Forbidden Access' })
  @Post('search')
  @UseGuards(JwtAuthGuard)
  async searchManga(
    @Body() searchMangaDto: SearchMangaDto,
  ): Promise<MangaQuickViewDto[]> {
    return await this.mangasService.searchManga(
      searchMangaDto.search_pattern,
      searchMangaDto.limit,
      searchMangaDto.offset,
    );
  }
}
