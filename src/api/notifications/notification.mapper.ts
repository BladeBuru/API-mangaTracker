import { stripEmailFormat } from '@/api/user/auth/username.helper';
import {
  NotificationActorDto,
  NotificationDto,
  NotificationMangaDto,
} from './dto/notification.dto';
import { Notification } from './notification.entity';
import { NotificationType } from './notification-type';

/**
 * Textes rédigés par d'autres utilisateurs, relus en direct pour la page
 * affichée (cf. `notification-type.ts` : jamais stockés dans `data`).
 */
export interface NotificationLiveRefs {
  /** `manga_share.id` → message de l'expéditeur (absent = partage supprimé). */
  shareMessages: Map<number, string | null>;
  /** `reading_group.id` → nom du groupe (absent = groupe supprimé). */
  groupNames: Map<number, string | null>;
}

/** Entier lu dans `data` (jsonb), 0 si absent ou invalide. */
export function readInt(data: Record<string, unknown>, key: string): number {
  const value = Number(data?.[key]);
  return Number.isFinite(value) ? value : 0;
}

function toActorDto(notification: Notification): NotificationActorDto | null {
  const actor = notification.actor;
  if (!actor) return null;
  // Defense-in-depth RGPD : jamais de format email exposé (hotfix-v0-10-1).
  return {
    id: actor.id,
    username: stripEmailFormat(actor.username),
    displayName: actor.displayName ? stripEmailFormat(actor.displayName) : null,
  };
}

function toMangaDto(notification: Notification): NotificationMangaDto | null {
  const manga = notification.manga;
  if (!manga) return null;
  return {
    muId: Number(manga.mu_id),
    title: manga.title,
    // Même source que `mediumCoverUrl` des cartes (`MangaQuickViewDto`).
    coverUrl: manga.medium_cover_url || null,
  };
}

/** `data` exposé au client, au format du contrat pour chaque type. */
function toDataDto(
  notification: Notification,
  refs: NotificationLiveRefs,
): Record<string, unknown> {
  const data = notification.data ?? {};
  switch (notification.type) {
    case NotificationType.FriendRequest:
    case NotificationType.FriendAccepted:
      return { friendshipId: readInt(data, 'friendshipId') };
    case NotificationType.MangaShare: {
      const shareId = readInt(data, 'shareId');
      return { shareId, message: refs.shareMessages.get(shareId) ?? null };
    }
    case NotificationType.ReadingGroupInvite: {
      const groupId = readInt(data, 'groupId');
      return { groupId, groupName: refs.groupNames.get(groupId) ?? null };
    }
    case NotificationType.NewChapters:
      return {
        latestChapter: readInt(data, 'latestChapter'),
        previousTotal: readInt(data, 'previousTotal'),
        readChapters: readInt(data, 'readChapters'),
      };
    default:
      return { ...data };
  }
}

export function toNotificationDto(
  notification: Notification,
  refs: NotificationLiveRefs,
): NotificationDto {
  return {
    id: notification.id,
    type: notification.type,
    createdAt: new Date(notification.createdAt).toISOString(),
    readAt: notification.readAt
      ? new Date(notification.readAt).toISOString()
      : null,
    actor: toActorDto(notification),
    manga: toMangaDto(notification),
    data: toDataDto(notification, refs),
  };
}
