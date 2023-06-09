import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { MangaQuickViewDto } from './dto/manga-quick-view.dto';
import { MangasService } from './mangas.service';
import { RetrieveMangaTrendsInternalDto } from './dto/retrieve-manga-trends-internal.dto';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { JwtAuthGuard } from '@/api/user/auth/auth.guard';

@ApiTags('Mangas')
@Controller('mangas')
export class MangasController {
  constructor(private readonly mangasService: MangasService) {}

  @ApiOperation({
    summary: 'Retrieve the top mangas according to their rating',
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 200,
    description:
      'Request has been validated. Retrieve the top mangas according to their rating',
    type: MangaQuickViewDto,
  })
  @UseGuards(JwtAuthGuard)
  @Get('top')
  async top(
    @Query()
    filters: RetrieveMangaTrendsInternalDto,
  ): Promise<MangaQuickViewDto[]> {
    return this.mangasService.retrieveMangaTrendsOrNews(
      'top',
      filters.limit,
      filters.offset,
    );
  }

  @ApiOperation({
    summary: 'Retrieve the top mangas according to their year of release',
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 200,
    description:
      'Request has been validated. Retrieve the top mangas according to their year of release',
    type: MangaQuickViewDto,
  })
  @UseGuards(JwtAuthGuard)
  @Get('latest')
  async latest(
    @Query()
    filters: RetrieveMangaTrendsInternalDto,
  ): Promise<MangaQuickViewDto[]> {
    return this.mangasService.retrieveMangaTrendsOrNews(
      'latest',
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
