import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export class UpdateCustomLinkDto {
  @ApiProperty({ description: 'ID du manga (muId)' })
  @IsNumber()
  muId: number;

  @ApiProperty({ description: 'Lien personnalisé', required: false })
  @IsString()
  @IsOptional()
  customLink?: string;
}
