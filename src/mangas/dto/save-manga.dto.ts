import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNumber } from 'class-validator';

export class SaveMangaDto {
  @ApiProperty({ description: 'MU ID of the manga' })
  @IsNumber()
  @IsInt()
  muId: number;
}
