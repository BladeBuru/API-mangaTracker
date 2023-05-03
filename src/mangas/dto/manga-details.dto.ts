import { plainToClass, classToPlain, Exclude } from 'class-transformer';
import { Manga } from '../manga.entity';
import { IsBoolean, IsNumber, IsString } from 'class-validator';

export class MangaDetailsDto {
  @IsNumber()
  muId: number;

  @IsString()
  title: string;

  @IsString()
  description: string;

  @IsNumber()
  year: number;

  @IsString()
  smallCoverUrl: string;

  @IsString()
  mediumCoverUrl: string;

  @IsNumber()
  rating: number;

  @IsNumber()
  totalChapters: number;

  @IsBoolean()
  completed: boolean;

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
    return mangaDetailsDto;
  }
}
