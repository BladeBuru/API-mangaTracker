import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SearchMangaDto {
  @ApiProperty({
    description: 'Texte recherché (titres + titres alternatifs)',
    example: 'Shadow System',
  })
  @IsString()
  @IsNotEmpty()
  search_pattern: string;

  @ApiPropertyOptional({
    description: 'Taille de page (1-100, défaut 20)',
    example: 20,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'Numéro de page (1-indexé, max 400 = borne MangaUpdates). Si présent, ' +
      'la réponse est une enveloppe paginée {results, totalHits, page, ' +
      'perPage, hasMore} ; sinon un tableau nu (rétrocompat clients ≤ 0.11.0).',
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(400)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({
    deprecated: true,
    description:
      'Déprécié (ancienne sémantique de page MU, jamais envoyé par les ' +
      'clients publiés). Ignoré — utiliser `page`.',
  })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  offset?: number;
}
