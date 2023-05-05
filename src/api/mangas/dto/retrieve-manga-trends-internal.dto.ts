import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class RetrieveMangaTrendsInternalDto {
  @ApiPropertyOptional({
    description: 'The number of retrieved mangas',
    default: 25,
    minimum: 1,
    maximum: 25,
    exclusiveMinimum: false,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(25)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'The offset is used to retrieve a subset of a large amount of mangas. It can be used if you want to skip the first n results and obtain only those after that.',
    default: 1,
    minimum: 1,
  })
  @IsOptional()
  @IsNumber()
  @IsInt()
  @Min(1)
  offset?: number;
}
