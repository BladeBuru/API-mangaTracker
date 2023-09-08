import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export class SearchMangaDto {
  @ApiProperty()
  @IsString()
  search_pattern: string;

  @ApiProperty()
  @IsOptional()
  @IsNumber()
  limit: number;

  @ApiProperty()
  @IsOptional()
  @IsNumber()
  offset: number;
}
