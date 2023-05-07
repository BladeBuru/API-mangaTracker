import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min } from 'class-validator';

export class SavedMangaDto {
  @ApiProperty({ description: 'User ID' })
  @IsNumber()
  @Min(0)
  userId: number;
}
