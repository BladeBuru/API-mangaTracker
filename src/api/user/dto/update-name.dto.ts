import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { Trim } from 'class-sanitizer';
import { USERNAME_PATTERN } from '../auth/username.helper';

/**
 * Changement d'identifiant (`username`, unique, insensible à la casse).
 *
 * Mêmes règles qu'à l'inscription : 3-32 caractères, pas de `@` (un
 * identifiant public ne doit jamais être une adresse email — RGPD).
 */
export class UpdateNameDto {
  @ApiProperty({ example: 'jean.dupont' })
  @IsString()
  @Trim()
  @Matches(USERNAME_PATTERN, {
    message:
      "Le nom d'utilisateur doit faire 3-32 caractères (lettres, chiffres, " +
      "espaces, '_', '.', '-') et ne peut pas être une adresse email.",
  })
  public readonly name: string;
}
