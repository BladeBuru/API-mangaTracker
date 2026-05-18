import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { FriendshipStatus, UserFriendship } from '../user-friendship.entity';
import User from '@/api/user/user.entity';

/**
 * Body pour `POST /friends/request`. Permet d'envoyer une demande
 * d'amitié via username OU userId — l'un OU l'autre est requis (vérifié
 * dans le service).
 */
export class SendFriendRequestDto {
  @ApiPropertyOptional({ description: "ID de l'utilisateur cible", example: 42 })
  @IsOptional()
  @IsInt()
  addresseeId?: number;

  @ApiPropertyOptional({
    description: "Username de l'utilisateur cible",
    example: 'OtakuSensei',
  })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  addresseeUsername?: string;
}

/** Body pour `PATCH /friends/:requestId` */
export class UpdateFriendshipStatusDto {
  @ApiProperty({ enum: FriendshipStatus, example: FriendshipStatus.Accepted })
  @IsEnum(FriendshipStatus)
  status: FriendshipStatus;
}

/**
 * Réponse pour une amitié : inclut l'autre utilisateur (pas celui qui
 * fait la requête) pour simplifier l'affichage côté Flutter.
 */
export class FriendshipDto {
  @ApiProperty()
  id: number;

  @ApiProperty({ enum: FriendshipStatus })
  status: FriendshipStatus;

  @ApiProperty({
    description: "Direction : 'sent' (je suis requester) ou 'received'",
  })
  direction: 'sent' | 'received';

  @ApiProperty({ description: "ID de l'autre utilisateur" })
  otherUserId: number;

  @ApiProperty()
  otherUsername: string;

  @ApiPropertyOptional()
  otherDisplayName?: string | null;

  @ApiPropertyOptional()
  otherAvatarUrl?: string | null;

  @ApiProperty()
  createdAt: string;

  @ApiPropertyOptional()
  acceptedAt?: string | null;

  static fromEntity(
    friendship: UserFriendship,
    currentUserId: number,
  ): FriendshipDto {
    const isRequester = friendship.requester.id === currentUserId;
    const other = isRequester ? friendship.addressee : friendship.requester;
    const dto = new FriendshipDto();
    dto.id = friendship.id;
    dto.status = friendship.status;
    dto.direction = isRequester ? 'sent' : 'received';
    dto.otherUserId = other.id;
    dto.otherUsername = other.username;
    dto.otherDisplayName = other.displayName ?? null;
    dto.otherAvatarUrl = other.avatarUrl ?? null;
    dto.createdAt = friendship.createdAt.toISOString();
    dto.acceptedAt = friendship.acceptedAt?.toISOString() ?? null;
    return dto;
  }
}

/** Résultat d'une recherche d'utilisateur pour autocomplete. */
export class UserSearchResultDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  username: string;

  @ApiPropertyOptional()
  displayName?: string | null;

  @ApiPropertyOptional()
  avatarUrl?: string | null;

  static fromEntity(user: User): UserSearchResultDto {
    const dto = new UserSearchResultDto();
    dto.id = user.id;
    dto.username = user.username;
    dto.displayName = user.displayName ?? null;
    dto.avatarUrl = user.avatarUrl ?? null;
    return dto;
  }
}
