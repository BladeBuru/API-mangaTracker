import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Min } from 'class-validator';
import { NotificationType } from '../notification-type';

/** Taille de page par défaut de `GET /notifications`. */
export const DEFAULT_NOTIFICATIONS_PAGE = 30;
/** Taille de page maximale (une valeur supérieure est ramenée à 50). */
export const MAX_NOTIFICATIONS_PAGE = 50;

/** Query de `GET /notifications`. */
export class ListNotificationsQueryDto {
  @ApiPropertyOptional({
    description:
      'Taille de page (défaut 30, maximum 50 — une valeur supérieure est ramenée à 50)',
    example: 30,
    minimum: 1,
    maximum: MAX_NOTIFICATIONS_PAGE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'Curseur : ne renvoie que les notifications créées STRICTEMENT avant cette date ISO 8601 (valeur `nextBefore` de la page précédente)',
    example: '2026-10-13T08:15:30.123Z',
  })
  @IsOptional()
  @IsDateString()
  before?: string;
}

/** Auteur de l'événement (ami), réduit au strict nécessaire à l'affichage. */
export class NotificationActorDto {
  @ApiProperty({ example: 42 })
  id: number;

  @ApiProperty({ example: 'OtakuSensei' })
  username: string;

  @ApiProperty({ nullable: true, type: String, example: 'Otaku Sensei' })
  displayName: string | null;
}

/** Manga concerné. */
export class NotificationMangaDto {
  @ApiProperty({ example: 55099564912 })
  muId: number;

  @ApiProperty({ example: 'One Piece' })
  title: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Même URL que `mediumCoverUrl` des cartes manga (image MangaUpdates en taille originale) ; null si inconnue',
  })
  coverUrl: string | null;
}

export class NotificationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: NotificationType, example: NotificationType.MangaShare })
  type: NotificationType;

  @ApiProperty({ example: '2026-10-13T08:15:30.123Z' })
  createdAt: string;

  @ApiProperty({ nullable: true, type: String, example: null })
  readAt: string | null;

  @ApiProperty({ nullable: true, type: NotificationActorDto })
  actor: NotificationActorDto | null;

  @ApiProperty({ nullable: true, type: NotificationMangaDto })
  manga: NotificationMangaDto | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Selon `type` — friend_request / friend_accepted : `{ friendshipId }` ; ' +
      'manga_share : `{ shareId, message: string|null }` ; ' +
      'reading_group_invite : `{ groupId, groupName: string|null }` ; ' +
      'new_chapters : `{ latestChapter, previousTotal, readChapters }`',
    example: { shareId: 12, message: 'Tu vas adorer' },
  })
  data: Record<string, unknown>;
}

export class NotificationListDto {
  @ApiProperty({ type: [NotificationDto] })
  items: NotificationDto[];

  @ApiProperty({ description: 'Total des non lues (toutes pages)', example: 3 })
  unreadCount: number;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'À repasser en `before` pour la page suivante ; null quand il n’y en a plus',
  })
  nextBefore: string | null;
}

export class UnreadCountDto {
  @ApiProperty({ example: 3 })
  count: number;
}

export class MarkReadResultDto {
  @ApiProperty({ example: true })
  ok: true;
}

export class MarkAllReadResultDto {
  @ApiProperty({ description: 'Notifications passées à « lue »', example: 3 })
  updated: number;
}
