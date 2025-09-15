import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export class UpdateCustomLinkDto {
  @ApiProperty({ description: 'MU ID of the manga' })
  @IsNumber()
  muId: number;

  @ApiProperty({ description: 'Custom user link', required: false })
  @IsString()
  @IsOptional()
  customLink?: string;
}
