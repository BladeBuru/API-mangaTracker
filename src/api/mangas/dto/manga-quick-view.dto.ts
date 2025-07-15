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

  @IsOptional()
  @ApiPropertyOptional()
  public readingStatus: string;

  @IsOptional()
  @ApiPropertyOptional({
    description: 'List of associated names (other titles) for this manga',
  })
  associated?: { title: string }[];

  @IsOptional()
  @ApiPropertyOptional({
    description: 'Custom user link for this manga',
  })
  customLink?: string;

  @IsOptional()
  @ApiPropertyOptional({
    description: 'List of genres for this manga',
  })
  genres?: { genre: string }[];

  @ApiProperty()
  type: string;

  static fromMu(data: any) {
    const dto = new MangaQuickViewDto();
    dto.muId = data['record']['series_id'];
    dto.title = data['record']['title'];
    dto.year = data['record']['year'];
    dto.mediumCoverUrl = data['record']['image']['url']['thumb'];
    dto.largeCoverUrl = data['record']['image']['url']['original'];
    dto.rating = data['record']['bayesian_rating'];
    dto.associated = data['record']['associated'] ?? [];
    dto.genres = data['record']['genres'] ?? [];
    dto.type = data['record']['type'];
    return dto;
  }

  static fromLibrary(userManga: UserManga) {
    const dto = new MangaQuickViewDto();
    dto.muId = parseInt(userManga.manga.mu_id);
    dto.title = userManga.manga.title;
    dto.year = userManga.manga.year;
    dto.mediumCoverUrl = userManga.manga.small_cover_url;
    dto.largeCoverUrl = userManga.manga.medium_cover_url;
    dto.rating = userManga.manga.rating;
    dto.readChapters = userManga.user_read_chapters;
    dto.totalChapters = userManga.manga.total_chapters;
    dto.readingStatus = userManga.reading_status;
    dto.associated = userManga.manga.associated ?? [];
    dto.genres = userManga.manga.genres ?? [];
    dto.type = userManga.manga.type;
    dto.customLink = userManga.custom_link ?? undefined;
    return dto;
  }

  static arrayFromMu(array: any): MangaQuickViewDto[] {
    const mangas: MangaQuickViewDto[] = new Array(array.length);
    for (let i = 0; i < array.length; i++) {
      mangas[i] = MangaQuickViewDto.fromMu(array[i]);
    }
    return mangas;
  }
}
