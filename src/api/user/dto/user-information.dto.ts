import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import User, { UserGender } from '../user.entity';

export class UserInformationDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  email: string;

  @ApiProperty()
  username: string;

  /**
   * `true` si l'utilisateur a cliqué sur le lien de vérification reçu
   * par mail. Utilisé côté client pour afficher un banner « Vérifiez
   * votre email » et bloquer certaines actions sensibles.
   */
  @ApiPropertyOptional({
    description:
      "Indique si l'email de l'utilisateur a été vérifié via le magic link",
  })
  emailVerified?: boolean;

  // ─────── Phase 3 : profil étendu ───────

  @ApiPropertyOptional()
  displayName?: string | null;

  @ApiPropertyOptional()
  bio?: string | null;

  @ApiPropertyOptional()
  avatarUrl?: string | null;

  @ApiPropertyOptional({
    description: 'Date de naissance (ISO date) — opt-in RGPD',
  })
  dateOfBirth?: string | null;

  @ApiPropertyOptional({ enum: UserGender })
  gender?: UserGender | null;

  @ApiPropertyOptional({
    description: 'Profil public visible par les amis',
  })
  isProfilePublic?: boolean;

  static fromEntity(user: User): UserInformationDto {
    const dto = new UserInformationDto();
    dto.id = user.id;
    dto.username = user.username;
    dto.email = user.email;
    dto.emailVerified = user.emailVerifiedAt !== null;
    dto.displayName = user.displayName ?? null;
    dto.bio = user.bio ?? null;
    dto.avatarUrl = user.avatarUrl ?? null;
    // Date stockée en `date` (YYYY-MM-DD). On normalise en ISO date.
    dto.dateOfBirth = user.dateOfBirth
      ? new Date(user.dateOfBirth).toISOString().split('T')[0]
      : null;
    dto.gender = user.gender ?? null;
    dto.isProfilePublic = user.isProfilePublic ?? false;
    return dto;
  }
}
