import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MangaQuickViewDto } from '../../dto/manga-quick-view.dto';

/** Bornes communes du nombre de titres par section. */
export const HOME_LIMIT_MIN = 5;
export const HOME_LIMIT_MAX = 40;
export const HOME_DEFAULT_LIMIT = 20;
export const HOME_PAGE_DEFAULT_LIMIT = 40;

/** Query de `GET /mangas/home/sections`. */
export class HomeSectionsQueryDto {
  @ApiPropertyOptional({
    description: 'Nombre de titres par section',
    default: HOME_DEFAULT_LIMIT,
    minimum: HOME_LIMIT_MIN,
    maximum: HOME_LIMIT_MAX,
    example: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(HOME_LIMIT_MIN)
  @Max(HOME_LIMIT_MAX)
  limit?: number;
}

/** Query de `GET /mangas/home/sections/:id`. */
export class HomeSectionPageQueryDto {
  @ApiPropertyOptional({
    description: 'Page (1-indexée)',
    default: 1,
    minimum: 1,
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: 'Titres par page',
    default: HOME_PAGE_DEFAULT_LIMIT,
    minimum: HOME_LIMIT_MIN,
    maximum: HOME_LIMIT_MAX,
    example: 40,
  })
  @IsOptional()
  @IsInt()
  @Min(HOME_LIMIT_MIN)
  @Max(HOME_LIMIT_MAX)
  limit?: number;
}

/** Une section de l'accueil. Pas de titre : le client traduit `kind` + `params`. */
export class HomeSectionDto {
  @ApiProperty({
    description:
      'Identifiant stable de la section (`latest`, `type:Manhwa`, `genre:Action`, `year:2014`…). ' +
      'À passer à `GET /mangas/home/sections/:id` pour la liste paginée.',
    example: 'type:Manhwa',
  })
  id: string;

  @ApiProperty({
    description: 'Nature de la section',
    enum: [
      'latest',
      'popular',
      'top_rated',
      'type',
      'genre',
      'year',
      'community',
      'hidden_gems',
    ],
    example: 'type',
  })
  kind: string;

  @ApiProperty({
    description:
      'Paramètres de la section : `{}` pour les sections fixes, `{type}`, `{genre}` ou `{year}` sinon',
    example: { type: 'Manhwa' },
  })
  params: Record<string, string | number>;

  @ApiProperty({ type: [MangaQuickViewDto] })
  items: MangaQuickViewDto[];
}

/** Réponse de `GET /mangas/home/sections`. */
export class HomeSectionsResponseDto {
  @ApiProperty({
    description: 'Horodatage ISO de la génération (cache serveur ~10 min)',
    example: '2026-09-05T10:00:00.000Z',
  })
  generatedAt: string;

  @ApiProperty({ type: [HomeSectionDto] })
  sections: HomeSectionDto[];
}

/** Réponse de `GET /mangas/home/sections/:id`. */
export class HomeSectionPageDto extends HomeSectionDto {
  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 40 })
  limit: number;

  @ApiProperty({
    description: 'Nombre total de titres de la section',
    example: 561,
  })
  total: number;
}
