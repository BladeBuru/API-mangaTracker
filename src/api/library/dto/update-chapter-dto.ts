import { IsNumber, IsOptional, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateChapterDto {
  @ApiProperty()
  @IsNumber()
  muId: number;

  @ApiProperty({ description: 'User ID' })
  @IsNumber()
  @Min(0)
  userId: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  readChapters: number;
}
