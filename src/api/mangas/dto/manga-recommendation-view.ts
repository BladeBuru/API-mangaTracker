import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class MangaRecommendationView {
  @ApiProperty()
  muId: number;

  @ApiProperty()
  title: string;

  @ApiProperty()
  year: number;

  @ApiProperty()
  smallCoverUrl: string;

  @ApiProperty()
  mediumCoverUrl: string;

  @ApiProperty()
  rating: number;

  @IsOptional()
  @ApiPropertyOptional()
  public readingStatus: string;

  @ApiPropertyOptional({
    description: "Indicates if the manga is in the user's library",
  })
  @IsOptional()
  @IsBoolean()
  inLibrary?: boolean;
}
