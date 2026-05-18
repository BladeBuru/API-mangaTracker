import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import User from '../user.entity';

/**
 * Profil public d'un utilisateur — exposé via `GET /user/profile/:id` quand
 * `isProfilePublic = true` (Phase 3). Ne JAMAIS exposer l'email, le mot de
 * passe, le googleId, ou la date de naissance brute.
 */
export class PublicProfileDto {
  @ApiProperty({ example: 42 })
  id: number;

  @ApiProperty({ example: 'OtakuSensei' })
  username: string;

  @ApiPropertyOptional({ example: 'Otaku Sensei' })
  displayName?: string | null;

  @ApiPropertyOptional({ example: 'Fan de seinen depuis 2010.' })
  bio?: string | null;

  @ApiPropertyOptional({
    example: 'https://app.bladeburu.com/uploads/avatars/42.jpg',
  })
  avatarUrl?: string | null;

  @ApiProperty({ example: '2024-08-15T12:30:00.000Z' })
  accountCreatedAt: string;

  static fromEntity(user: User): PublicProfileDto {
    const dto = new PublicProfileDto();
    dto.id = user.id;
    dto.username = user.username;
    dto.displayName = user.displayName ?? user.username;
    dto.bio = user.bio ?? null;
    dto.avatarUrl = user.avatarUrl ?? null;
    dto.accountCreatedAt =
      user.createdAt?.toISOString() ?? new Date().toISOString();
    return dto;
  }
}
