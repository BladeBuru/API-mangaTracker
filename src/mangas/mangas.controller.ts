import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { RetrieveMangaTrendsDto } from './dto/retrieve-manga-trends.dto';
import { MangasService } from './mangas.service';
import { RetrieveMangaTrendsInternalDto } from './dto/retrieve-manga-trends-internal.dto';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { SaveMangaDto } from './dto/save-manga.dto';
import { Manga } from './manga.entity';
import { NotFoundInterceptor } from 'src/interceptors/not-found.interceptor';

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
    type: RetrieveMangaTrendsDto,
  })
  @Get('top')
  async top(
    @Query()
    filters: RetrieveMangaTrendsInternalDto,
  ): Promise<RetrieveMangaTrendsDto[]> {
    return this.mangasService.retrieveMangaTrends(
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
}
