import { ApiProperty } from '@nestjs/swagger';

export class RetrieveMangaTrendsDto {
  @ApiProperty()
  title: string;

  @ApiProperty()
  mediumCoverUrl: string;

  @ApiProperty()
  largeCoverUrl: string;

  @ApiProperty()
  rank: number;

  static fromMal(malData: any) {
    const dto = new RetrieveMangaTrendsDto();
    dto.title = malData['node']['title'];
    dto.mediumCoverUrl = malData['node']['main_picture']['medium'];
    dto.largeCoverUrl = malData['node']['main_picture']['large'];
    dto.rank = malData['ranking']['rank'];
    return dto;
  }
}
