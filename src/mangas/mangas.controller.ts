import { Controller, Get, Query } from '@nestjs/common';
import { RetrieveMangaTrendsDto } from './dto/retrieve-manga-trends.dto';
import { MangasService } from './mangas.service';
import { RetrieveMangaTrendsInternalDto } from './dto/retrieve-manga-trends-internal.dto';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('Mangas')
@Controller('mangas')
export class MangasController {
  constructor(private readonly mangasService: MangasService) {}

  @ApiOperation({ summary: 'Retrieve the top mangas according to MAL ranking' })
  @ApiResponse({ status: 400, description: 'Bad Request' })
  @ApiResponse({
    status: 200,
    description:
      'Request has been validated. Retrieve the top mangas according to MAL ranking',
    type: RetrieveMangaTrendsDto,
  })
  @Get('retrieveMangaTrends')
  async retrieveMangaTrends(
    @Query()
    filters: RetrieveMangaTrendsInternalDto,
  ): Promise<RetrieveMangaTrendsDto[]> {
    return this.mangasService.retrieveMangaTrends(
      filters.limit,
      filters.offset,
    );
  }
}
