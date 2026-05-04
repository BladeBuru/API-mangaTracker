import { IsInt, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateRatingDto {
  @ApiProperty({ description: 'MangaUpdates ID du manga' })
  @IsInt()
  muId: number;

  @ApiProperty({ description: 'Note de 1 à 10 (0 = supprimer la note)' })
  @IsInt()
  @Min(0)
  @Max(10)
  rating: number;
}
