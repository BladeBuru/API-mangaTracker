import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { MangaQuickViewDto } from './dto/manga-quick-view';
import { MangasService } from './mangas.service';
import { RetrieveMangaTrendsInternalDto } from './dto/retrieve-manga-trends-internal.dto';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { SaveMangaDto } from './dto/save-manga.dto';
import { NotFoundInterceptor } from 'src/interceptors/not-found.interceptor';
import { SavedMangaDto } from './dto/saved-manga.dto';

@ApiTags('Mangas')
@Controller('mangas')
export class MangasController {
  constructor(private readonly mangasService: MangasService) {}

  private readonly logger = new Logger(MangasService.name);

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
  @Get(':id')
  async mangaDetails(@Param('id') id: number): Promise<MangaDetailsDto> {
    return await this.mangasService.getMangaDetails(id);
  }

  @ApiOperation({
    summary: "Add a manga to user's collection",
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 200,
    description:
      "Request has been validated. Add the manga with given id to user's collection",
    type: MangaDetailsDto,
  })
  @UseInterceptors(NotFoundInterceptor)
  @Post('save')
  async save(@Body() saveMangaDto: SaveMangaDto): Promise<MangaDetailsDto> {
    return await this.mangasService.saveMangaToLibrary(
      saveMangaDto.muId,
      saveMangaDto.userId,
    );
  }

  @ApiOperation({ summary: 'Return mangas in user library' })
  @ApiResponse({
    status: 200,
    description: 'Request has been validated. Return mangas in user library',
    type: MangaQuickViewDto,
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @Post('saved')
  async saved(
    @Body() savedMangaDto: SavedMangaDto,
  ): Promise<MangaQuickViewDto[]> {
    return this.mangasService.getUserMangas(savedMangaDto.userId);
  }

  @ApiOperation({ summary: 'Delete given manga in user library' })
  @ApiResponse({
    status: 200,
    description: 'Return true if the manga has been deleted from user library',
    type: MangaQuickViewDto,
  })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({ status: 404, description: 'Entry not found' })
  @Delete('delete')
  async delete(@Body() deleteMangaDto: SaveMangaDto): Promise<boolean> {
    return await this.mangasService.deleteMangaFromLibrary(
      deleteMangaDto.userId,
      deleteMangaDto.muId,
    );
  }
}
