import { plainToClass, classToPlain } from 'class-transformer';
import { Manga } from '../manga.entity';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MangaDetailsDto {
  @ApiProperty()
  @IsNumber()
  muId: number;

  @ApiProperty()
  @IsString()
  title: string;

  @ApiProperty()
  @IsString()
  description: string;

  @ApiProperty()
  @IsNumber()
  year: number;

  @ApiProperty()
  @IsString()
  smallCoverUrl: string;

  @ApiProperty()
  @IsString()
  mediumCoverUrl: string;

  @ApiProperty()
  @IsNumber()
  rating: number;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  readChapters: number;

  @ApiProperty()
  @IsNumber()
  totalChapters: number;

  @ApiProperty()
  @IsBoolean()
  completed: boolean;

  @ApiPropertyOptional()
  authors: any[];

  @ApiPropertyOptional()
  genres: any[];

  @ApiPropertyOptional()
  anime: any[];

  @ApiPropertyOptional()
  categories: any[];

  @ApiPropertyOptional({ description: 'Lien personnalisé de l’utilisateur pour ce manga' })
  @IsOptional()
  @IsString()
  customLink?: string;

  @ApiPropertyOptional({ description: 'Indique si le manga est dans la bibliothèque de l’utilisateur' })
  @IsOptional()
  @IsBoolean()
  inLibrary?: boolean;

  @ApiPropertyOptional({ description: 'Nombre de chapitres lus par l’utilisateur' })
  @IsOptional()
  @IsNumber()
  readChaptersCount?: number;

  static toModel(mangaDetailsDto: MangaDetailsDto): Manga {
    const data = classToPlain(mangaDetailsDto);
    return plainToClass(Manga, data);
  }

  static fromMU(muObject: any): MangaDetailsDto {
    const mangaDetailsDto = new MangaDetailsDto();
    mangaDetailsDto['title'] = muObject['title'];
    mangaDetailsDto['description'] = muObject['description'];
    mangaDetailsDto['small_cover_url'] = muObject['image']['url']['thumb'];
    mangaDetailsDto['medium_cover_url'] = muObject['image']['url']['original'];
    mangaDetailsDto['year'] = muObject['year'];
    mangaDetailsDto['rating'] = muObject['bayesian_rating'];
    mangaDetailsDto['total_chapters'] = muObject['latest_chapter'];
    mangaDetailsDto['completed'] = muObject['completed'];
    mangaDetailsDto['mu_id'] = muObject['series_id'];
    mangaDetailsDto['authors'] = muObject['authors'];
    mangaDetailsDto['genres'] = muObject['genres'];
    mangaDetailsDto['anime'] = muObject['anime'];
    mangaDetailsDto['categories'] = muObject['categories'];
    return mangaDetailsDto;
  }
}
