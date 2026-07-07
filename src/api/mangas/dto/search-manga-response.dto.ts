import { ApiProperty } from '@nestjs/swagger';
import { MangaQuickViewDto } from './manga-quick-view.dto';

export class SearchMangaResponseDto {
  @ApiProperty({
    type: MangaQuickViewDto,
    isArray: true,
    description: 'Résultats de la page demandée, triés par pertinence',
  })
  results: MangaQuickViewDto[];

  @ApiProperty({
    description: 'Nombre total de résultats côté MangaUpdates',
    example: 2486,
  })
  totalHits: number;

  @ApiProperty({ description: 'Page renvoyée (1-indexée)', example: 1 })
  page: number;

  @ApiProperty({ description: 'Taille de page effective', example: 20 })
  perPage: number;

  @ApiProperty({
    description: 'Vrai s’il reste au moins une page à charger',
    example: true,
  })
  hasMore: boolean;
}
