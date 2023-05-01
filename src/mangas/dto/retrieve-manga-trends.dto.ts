import { ApiProperty } from '@nestjs/swagger';

export class RetrieveMangaTrendsDto {
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

  static fromMu(data: any) {
    const dto = new RetrieveMangaTrendsDto();
    dto.muId = data['record']['series_id'];
    dto.title = data['record']['title'];
    dto.year = data['record']['year'];
    dto.mediumCoverUrl = data['record']['image']['url']['thumb'];
    dto.largeCoverUrl = data['record']['image']['url']['original'];
    dto.rating = data['record']['bayesian_rating'];
    return dto;
  }
}
