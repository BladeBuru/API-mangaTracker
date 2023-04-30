import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class RetrieveMangaTrendsInternalDto {
  @ApiPropertyOptional({
    description: 'The number of retrieved mangas',
    default: '100',
  })
  @IsOptional()
  @IsString()
  limit?: string;

  @ApiPropertyOptional({
    description:
      'The offset is used to retrieve a subset of a large amount of mangas. It can be used if you want to skip the first n results and obtain only those after that.',
    default: '0',
  })
  @IsString()
  offset?: string;
}
