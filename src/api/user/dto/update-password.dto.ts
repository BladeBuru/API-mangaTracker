import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Changement de mot de passe d'un utilisateur connecté (`PUT /user/password`).
 *
 * Sécurité : le mot de passe ACTUEL est exigé pour empêcher un attaquant en
 * possession d'un access token volé (device déverrouillé, XSS…) de prendre
 * définitivement le contrôle du compte en remplaçant le mot de passe.
 *
 * Politique de complexité du nouveau mot de passe — identique à
 * `ConfirmPasswordResetDto` (reset par email) :
 *  - 8 caractères minimum, 128 maximum
 *  - Au moins 1 chiffre OU 1 caractère spécial
 */
export class UpdatePasswordDto {
  @ApiProperty({ description: 'Mot de passe actuel (vérifié côté serveur)' })
  @IsString()
  @IsNotEmpty()
  public readonly currentPassword: string;

  @ApiProperty({ description: 'Nouveau mot de passe' })
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  @Matches(/^(?=.*\d)|(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])/, {
    message: 'Password must contain at least one number or special character',
  })
  public readonly newPassword: string;
}
