import { ApiProperty } from '@nestjs/swagger';
import {
  IsHexadecimal,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Confirme un reset de mot de passe avec le token reçu par email + le
 * nouveau mot de passe.
 *
 * Politique de complexité :
 *  - 8 caractères minimum
 *  - Au moins 1 chiffre OU 1 caractère spécial
 *
 * Pas trop strict pour ne pas pousser l'utilisateur à des mots de passe
 * faciles ; on s'appuie surtout sur la longueur (NIST recommandation).
 */
export class ConfirmPasswordResetDto {
  @ApiProperty({
    description: 'Token reçu par email',
    minLength: 64,
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @IsHexadecimal()
  @Length(64, 64)
  token: string;

  @ApiProperty({ description: 'Nouveau mot de passe' })
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  @Matches(/^(?=.*\d)|(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])/, {
    message: 'Password must contain at least one number or special character',
  })
  newPassword: string;
}
