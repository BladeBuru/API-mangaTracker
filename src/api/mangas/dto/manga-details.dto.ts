import { plainToClass, classToPlain } from 'class-transformer';
import { Manga } from '../manga.entity';
import { IsArray, IsBoolean, IsNumber, IsString } from 'class-validator';

export class MangaDetailsDto {
  @IsNumber()
  muId: number;

  @IsString()
  title: string;

  @IsNumber()
  year: number;

  @IsString()
  mediumCoverUrl: string;

  @IsString()
  largeCoverUrl: string;

  @IsNumber()
  rating: number;

  @IsArray()
  genres: string[];

  @IsNumber()
  latest_chapter: number;

  @IsString()
  status: string;

  @IsBoolean()
  completed: boolean;

  static toModel(mangaDetailsDto: MangaDetailsDto): Manga {
    const data = classToPlain(mangaDetailsDto);
    return plainToClass(Manga, data);
  }
}
