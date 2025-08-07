import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UnauthorizedException,
  NotFoundException,
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
import { ConfigService } from '@nestjs/config';
import { MangaSyncService } from './sync-manga.service';
import { MangaRecommendationView } from './dto/manga-recommendation-view';

@ApiTags('Mangas')
@ApiBearerAuth()
@Controller('mangas')
export class MangasController {
  constructor(
    private readonly mangasService: MangasService,
    private readonly libraryService: LibraryService,
    private readonly configService: ConfigService,
    private readonly mangaSyncService: MangaSyncService,
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
    @Param('id') id: number,
    @UserDecorator() user: any,
  ): Promise<MangaDetailsDto> {
    const mangaDetails = await this.mangasService.getMangaDetails(id);
    let customLink: string | undefined = undefined;
    let inLibrary = false;
    let readChaptersCount: number | undefined = undefined;
    if (user?.id) {
      const userManga = await this.libraryService.getUserManga(user.id, id);
      if (userManga) {
        customLink = userManga.custom_link ?? undefined;
        inLibrary = true;
        readChaptersCount = userManga.user_read_chapters;
      }
    }
    return {
      ...mangaDetails,
      customLink: customLink,
      inLibrary: inLibrary,
      readChaptersCount: readChaptersCount,
    };
  }

  @ApiOperation({
    summary: 'Get recommendations of the manga with given id',
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 200,
    description:
      'Request has been validated. Get the manga recommendations with given id',
    type: MangaRecommendationView,
  })
  @UseGuards(JwtAuthGuard)
  @Get('recommendations/:id')
  async mangaRecommendations(
    @Param('id') id: number,
    @UserDecorator() user: any,
  ): Promise<MangaRecommendationView[]> {
    const manga =
      (await this.mangasService.returnMangaIfExist(id.toString())) ??
      (await this.mangasService.getMangaDetails(id));

    if (!manga) {
      throw new NotFoundException(`Manga with id ${id} cannot be found`);
    }

    const recommendations = manga.recommendations ?? [];

    return await Promise.all(
      recommendations.map(async (recommendation) => {
        let readingStatus: string | undefined = undefined;
        let inLibrary = false;

        if (user?.id) {
          const userManga = await this.libraryService.getUserManga(
            user.id,
            parseInt(recommendation),
          );

          if (userManga) {
            readingStatus = userManga.reading_status ?? undefined;
            inLibrary = true;
          }
        }

        const details = await this.mangasService.getMangaDetails(
          parseInt(recommendation),
        );

        const dto = new MangaRecommendationView();
        dto.muId = details.muId;
        dto.title = details.title;
        dto.year = details.year;
        dto.smallCoverUrl = details.smallCoverUrl;
        dto.mediumCoverUrl = details.mediumCoverUrl;
        dto.rating = details.rating;
        dto.readingStatus = readingStatus;
        dto.inLibrary = inLibrary;

        return dto;
      }),
    );
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

  @Post('admin/sync-all')
  async syncAllMangas(@Query('secret') secret: string) {
    const adminSecret = this.configService.get<string>('DATABASE_PASSWORD');
    if (secret !== adminSecret) {
      throw new UnauthorizedException('Invalid secret');
    }
    await this.mangaSyncService.syncAllMangasWithApi();
    return { message: 'Synchronization started' };
  }
}
