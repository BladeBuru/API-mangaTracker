import { IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateChapterDto {
  @ApiProperty()
  @IsNumber()
  muId: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  readChapters: number;
}
