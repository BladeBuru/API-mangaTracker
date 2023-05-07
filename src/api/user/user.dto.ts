import { IsOptional, IsString } from 'class-validator';

export class UpdateNameDto {
  @IsString()
  @IsOptional()
  public readonly name?: string;
}
export class UpdatePasswordDto {
  @IsString()
  @IsOptional()
  public readonly password?: string;
}
