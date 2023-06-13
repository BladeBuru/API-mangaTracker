import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional } from 'class-validator';
import { UserManga } from '../user-manga.entity';

export class MangaQuickViewDto {
  @ApiProperty()
  muId: number;

  @ApiProperty()
  title: string;

  @ApiProperty()
  year: number;

  @ApiProperty()
  mediumCoverUrl: string;

  @ApiProperty()
  largeCoverUrl: string;

  @ApiProperty()
  rating: number;

  @IsNumber()
  @IsOptional()
  @ApiPropertyOptional()
  readChapters: number;

  @IsNumber()
  @IsOptional()
  @ApiPropertyOptional()
  totalChapters: number;

  static fromMu(data: any) {
    const dto = new MangaQuickViewDto();
    dto.muId = data['record']['series_id'];
    dto.title = data['record']['title'];
    dto.year = data['record']['year'];
    dto.mediumCoverUrl = data['record']['image']['url']['thumb'];
    dto.largeCoverUrl = data['record']['image']['url']['original'];
    dto.rating = data['record']['bayesian_rating'];
    return dto;
  }

  static fromLibrary(userManga: UserManga) {
    const dto = new MangaQuickViewDto();
    dto.muId = parseInt(userManga.manga.mu_id);
    dto.title = userManga.manga.title;
    dto.year = userManga.manga.year;
    dto.mediumCoverUrl = userManga.manga.small_cover_url;
    dto.largeCoverUrl = userManga.manga.medium_cover_url;
    dto.rating = userManga.user_rating;
    dto.readChapters = userManga.user_read_chapters;
    dto.totalChapters = userManga.manga.total_chapters;
    return dto;
  }
}
