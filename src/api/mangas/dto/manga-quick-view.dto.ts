import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional } from 'class-validator';

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

  static fromLibrary(data: any) {
    const dto = new MangaQuickViewDto();
    dto.muId = data['manga_mu_id'];
    dto.title = data['manga_title'];
    dto.year = data['manga_year'];
    dto.mediumCoverUrl = data['manga_small_cover_url'];
    dto.largeCoverUrl = data['manga_medium_cover_url'];
    dto.rating = data['userManga_user_rating'];
    dto.readChapters = data['userManga_user_read_chapters'];
    return dto;
  }
}
