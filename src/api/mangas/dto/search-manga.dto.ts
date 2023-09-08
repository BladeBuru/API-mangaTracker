import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class SearchMangaDto {
  @ApiProperty()
  @IsString()
  search_pattern: string;
}
