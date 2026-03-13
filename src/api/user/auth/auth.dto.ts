import { Trim } from 'class-sanitizer';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty()
  @Trim()
  @IsEmail()
  public readonly email: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  public readonly password: string;

  @ApiProperty()
  @IsString()
  @IsOptional()
  public readonly name?: string;
}

export class LoginDto {
  @ApiProperty()
  @Trim()
  @IsEmail()
  public readonly email: string;

  @ApiProperty()
  @IsString()
  public readonly password: string;

  @ApiProperty({ required: false, description: "Identifiant de l'appareil (user-agent, nom de l'app)" })
  @IsString()
  @IsOptional()
  public readonly deviceInfo?: string;
}

export class TokenDto {
  @ApiProperty()
  @IsString()
  public accessToken: string;

  @ApiProperty()
  @IsString()
  public refreshToken: string;
}
