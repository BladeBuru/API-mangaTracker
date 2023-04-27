import { Controller, Get } from '@nestjs/common';
import { RetrieveMangaTrendsDto } from './dto/retrieve-manga-trends.dto';
import { MangasService } from './mangas.service';

@Controller('mangas')
export class MangasController {
  constructor(private readonly mangasService: MangasService) {}

  @Get('retrieveMangaTrends')
  async retrieveMangaTrends(): Promise<RetrieveMangaTrendsDto[]> {
    return this.mangasService.retrieveMangaTrends();
  }
}
