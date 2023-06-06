
import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min } from 'class-validator';
export class FavoritesDto {

  @ApiProperty({ description: 'mangaid of the manga' })
  @IsNumber()
  @Min(0)
  mangaId: number;

  @ApiProperty({ description: 'User ID' })
  @IsNumber()
  @Min(0)
  userId: number;
}

