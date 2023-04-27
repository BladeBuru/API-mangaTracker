export class RetrieveMangaTrendsDto {
  title: string;

  mediumCover: string;

  largeCover: string;

  rank: number;

  static fromMal(malData: any) {
    const dto = new RetrieveMangaTrendsDto();
    dto.title = malData['node']['title'];
    dto.mediumCover = malData['node']['main_picture']['medium'];
    dto.largeCover = malData['node']['main_picture']['large'];
    dto.rank = malData['ranking']['rank'];
    return dto;
  }
}
