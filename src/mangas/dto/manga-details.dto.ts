import { plainToClass, classToPlain } from 'class-transformer';
import { Manga } from '../manga.entity';
import { IsArray, IsBoolean, IsNumber, IsString } from 'class-validator';

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
  latestChapter: number;

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
    mangaDetailsDto['latestChapter'] = muObject['latest_chapter'];
    mangaDetailsDto['completed'] = muObject['completed'];
    mangaDetailsDto['muId'] = muObject['series_id'];
    console.log(mangaDetailsDto['description']);
    return mangaDetailsDto;
  }
}
