import { IsOptional, IsString } from 'class-validator';
import {ApiProperty} from "@nestjs/swagger";

export class UpdateNameDto {
    @ApiProperty()
  @IsString()
  @IsOptional()
  public readonly name?: string;
}
export class UpdatePasswordDto {
    @ApiProperty()
  @IsString()
  @IsOptional()
  public readonly password?: string;
}
