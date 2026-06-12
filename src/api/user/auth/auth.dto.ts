import { Trim } from 'class-sanitizer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { USERNAME_PATTERN } from './username.helper';

export class RegisterDto {
  @ApiProperty()
  @Trim()
  @IsEmail()
  public readonly email: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  public readonly password: string;

  @ApiProperty({
    description:
      "Nom d'utilisateur public — 3-32 caractères alphanumériques, " +
      '`_ . -` et espaces. Le `@` est interdit : un username ne doit ' +
      'jamais être une adresse email (RGPD — il est affiché publiquement).',
    example: 'jean.dupont',
  })
  @IsString()
  @IsOptional()
  @Trim()
  @Matches(USERNAME_PATTERN, {
    message:
      "Le nom d'utilisateur doit faire 3-32 caractères (lettres, chiffres, " +
      "espaces, '_', '.', '-') et ne peut pas être une adresse email.",
  })
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

  @ApiProperty({
    required: false,
    description: "Identifiant de l'appareil (user-agent, nom de l'app)",
  })
  @IsString()
  @IsOptional()
  public readonly deviceInfo?: string;
}

export class GoogleMobileLoginDto {
  @ApiProperty({
    description:
      'ID Token Google obtenu via le package google_sign_in (Flutter mobile)',
  })
  @IsString()
  public readonly idToken: string;

  @ApiProperty({ required: false, description: "Identifiant de l'appareil" })
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
