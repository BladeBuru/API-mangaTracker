import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpdateNameDto {
  @ApiProperty()
  @IsString()
  @IsOptional()
  public readonly name?: string;
}
