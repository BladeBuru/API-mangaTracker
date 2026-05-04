import { ApiProperty } from '@nestjs/swagger';
import { IsHexadecimal, IsNotEmpty, IsString, Length } from 'class-validator';

/**
 * Token reçu dans le lien email de vérification.
 * 64 caractères hex = 256 bits d'entropie (cf. AuthTokenService).
 */
export class VerifyEmailDto {
  @ApiProperty({ description: 'Token de vérification reçu par email' })
  @IsString()
  @IsNotEmpty()
  @IsHexadecimal()
  @Length(64, 64)
  token: string;
}
