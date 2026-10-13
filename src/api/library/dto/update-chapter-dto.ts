import { IsNumber, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateChapterDto {
  @ApiProperty()
  @IsNumber()
  muId: number;

  @ApiProperty({ example: 42 })
  @IsNumber()
  @Min(0)
  // Borne de bon sens : sur un titre au total inconnu (0), il n'y a plus de
  // plafond métier, et une valeur hors `int` ferait échouer l'UPDATE en 500.
  @Max(100_000)
  readChapters: number;
}
