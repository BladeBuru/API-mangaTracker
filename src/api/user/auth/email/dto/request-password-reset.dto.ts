import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Demande d'envoi d'un email de reset password.
 *
 * L'endpoint qui consomme ce DTO retourne TOUJOURS 200, même si l'email
 * n'existe pas (anti-énumération). Le DTO ne fait que valider le format.
 */
export class RequestPasswordResetDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(255)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email: string;
}
