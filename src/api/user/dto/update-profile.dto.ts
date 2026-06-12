import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { UserGender } from '../user.entity';

/**
 * Met à jour les champs de profil étendu (Phase 3).
 *
 * Tous les champs sont optionnels — l'utilisateur peut PATCH un sous-ensemble.
 * `avatarUrl` accepte une URL (en attendant la mise en place de l'upload
 * multipart + storage NAS, l'utilisateur peut renseigner une URL externe
 * ou l'API la posera elle-même via le futur `POST /user/avatar`).
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({
    description: 'Nom à afficher publiquement (distinct du username)',
    example: 'Otaku Sensei',
  })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  public readonly displayName?: string;

  @ApiPropertyOptional({
    description: 'Courte description du profil (max 500 chars)',
    example:
      'Fan de seinen depuis 2010. Top 3 : Berserk, Vinland Saga, Vagabond.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public readonly bio?: string;

  /**
   * URL ou data URL d'avatar.
   *
   * Deux formats acceptés :
   *  - URL externe : `https://cdn.../foo.jpg`
   *  - data URL : `data:image/jpeg;base64,...` (image locale picker)
   *
   * `@IsUrl` est remplacé par une regex custom car `class-validator`
   * `@IsUrl` ne valide PAS les data URLs. On valide via `@Matches` :
   *  - `^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$` (data URL)
   *  - OU `^https?://...` (URL standard)
   *
   * `@MaxLength(512)` retiré : un base64 image 512×512 quality 75 fait
   * 40-80K caractères. La colonne est `text` (illimité) depuis la
   * migration `1746231600000-ChangeAvatarUrlToText`. On garde un cap
   * raisonnable de 200K caractères (~150 KB d'image) pour éviter qu'un
   * client envoie un payload géant.
   */
  @ApiPropertyOptional({
    description: "URL de l'avatar (jpg/png/webp) ou data URL base64",
    example: 'https://app.bladeburu.com/uploads/avatars/42.jpg',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  @Matches(
    /^(https?:\/\/[^\s]+|data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+)$/,
    {
      message:
        'avatarUrl doit être une URL http(s) ou un data URL image base64',
    },
  )
  public readonly avatarUrl?: string;

  @ApiPropertyOptional({
    description: 'Date de naissance (ISO 8601 date)',
    example: '1995-03-21',
  })
  @IsOptional()
  @IsDateString()
  public readonly dateOfBirth?: string;

  @ApiPropertyOptional({
    description: 'Genre déclaré',
    enum: UserGender,
    example: UserGender.PreferNotToSay,
  })
  @IsOptional()
  @IsEnum(UserGender)
  public readonly gender?: UserGender;

  @ApiPropertyOptional({
    description: 'Profil public visible par les amis',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  public readonly isProfilePublic?: boolean;
}
