import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { MangaQuickViewDto } from './dto/manga-quick-view.dto';
import { MangasService } from './mangas.service';
import { RetrieveMangaTrendsInternalDto } from './dto/retrieve-manga-trends-internal.dto';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';

@ApiTags('Mangas')
@Controller('mangas')
export class MangasController {
  constructor(private readonly mangasService: MangasService) {}

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
  async mangaDetails(@Param('id') id: number): Promise<MangaDetailsDto> {
    return await this.mangasService.getMangaDetails(id);
  }
}
