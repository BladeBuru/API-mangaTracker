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

  static toModel(mangaDetailsDto: MangaDetailsDto): Manga {
    const data = classToPlain(mangaDetailsDto);
    return plainToClass(Manga, data);
  }

  static fromMU(muObject: any): MangaDetailsDto {
    const mangaDetailsDto = new MangaDetailsDto();
    mangaDetailsDto['title'] = muObject['title'];
    mangaDetailsDto['description'] = muObject['description'];
    mangaDetailsDto['smallCoverUrl'] = muObject['image']['url']['thumb'];
    mangaDetailsDto['mediumCoverUrl'] = muObject['image']['url']['original'];
    mangaDetailsDto['year'] = muObject['year'];
    mangaDetailsDto['rating'] = muObject['bayesian_rating'];
    mangaDetailsDto['totalChapters'] = muObject['latest_chapter'];
    mangaDetailsDto['completed'] = muObject['completed'];
    mangaDetailsDto['muId'] = muObject['series_id'];
    mangaDetailsDto['authors'] = muObject['authors'];
    mangaDetailsDto['genres'] = muObject['genres'];
    mangaDetailsDto['anime'] = muObject['anime'];
    mangaDetailsDto['categories'] = muObject['categories'];
    return mangaDetailsDto;
  }
}
