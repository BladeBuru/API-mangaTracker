import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min } from 'class-validator';

export class SaveMangaDto {
  @ApiProperty({ description: 'MU ID of the manga' })
  @IsNumber()
  @Min(0)
  muId: number;

  @ApiProperty({ description: 'User ID' })
  @IsNumber()
  @Min(0)
  userId: number;
}
