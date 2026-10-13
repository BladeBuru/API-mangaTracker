import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository, SelectQueryBuilder } from 'typeorm';
import { MangaShare } from '@/api/sharing/manga-share.entity';
import { ReadingGroup } from '@/api/sharing/reading-group.entity';
import {
  DEFAULT_NOTIFICATIONS_PAGE,
  ListNotificationsQueryDto,
  MarkAllReadResultDto,
  MarkReadResultDto,
  MAX_NOTIFICATIONS_PAGE,
  NotificationListDto,
} from './dto/notification.dto';
import { Notification } from './notification.entity';
import {
  NotificationLiveRefs,
  readInt,
  toNotificationDto,
} from './notification.mapper';
import { NotificationType } from './notification-type';

/**
 * Lecture et acquittement des notifications de l'utilisateur courant.
 *
 * Toutes les requêtes sont bornées par `user_id` : un utilisateur ne voit
 * ni ne modifie jamais les notifications d'un autre (404 indistinct).
 * L'écriture des notifications est l'affaire de
 * `NotificationProducerService`.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    @InjectRepository(MangaShare)
    private readonly shareRepository: Repository<MangaShare>,
    @InjectRepository(ReadingGroup)
    private readonly groupRepository: Repository<ReadingGroup>,
  ) {}

  /**
   * Page de notifications, plus récentes d'abord, paginée par curseur
   * `before` (date de création strictement antérieure).
   *
   * Frontière de page : si plusieurs notifications partagent la date de la
   * dernière ligne, elles sont TOUTES servies sur cette page (elle peut donc
   * dépasser `limit` dans ce cas rare) — sinon le curseur `created_at <
   * nextBefore` sauterait celles restées de l'autre côté.
   */
  async list(
    userId: number,
    query: ListNotificationsQueryDto,
  ): Promise<NotificationListDto> {
    const limit = Math.min(
      query.limit ?? DEFAULT_NOTIFICATIONS_PAGE,
      MAX_NOTIFICATIONS_PAGE,
    );
    const pageQuery = this.pageQuery(userId);
    if (query.before) {
      pageQuery.andWhere('n.createdAt < :before', {
        before: new Date(query.before),
      });
    }
    const rows = await pageQuery.limit(limit + 1).getMany();

    let page = rows;
    let nextBefore: string | null = null;
    if (rows.length > limit) {
      page = rows.slice(0, limit);
      const boundary = page[limit - 1].createdAt;
      if (rows[limit].createdAt.getTime() === boundary.getTime()) {
        const ties = await this.pageQuery(userId)
          .andWhere('n.createdAt = :boundary', { boundary })
          .andWhere('n.id NOT IN (:...seen)', { seen: page.map((n) => n.id) })
          .getMany();
        page = page.concat(ties);
      }
      nextBefore = boundary.toISOString();
    }

    const [refs, unreadCount] = await Promise.all([
      this.loadLiveRefs(page),
      this.unreadCount(userId),
    ]);
    return {
      items: page.map((n) => toNotificationDto(n, refs)),
      unreadCount,
      nextBefore,
    };
  }

  /** Nombre de notifications non lues (badge). */
  async unreadCount(userId: number): Promise<number> {
    return this.notificationRepository.count({
      where: { userId, readAt: IsNull() },
    });
  }

  /**
   * Marque une notification lue. Idempotent (`read_at` d'origine conservé).
   * 404 si elle n'existe pas OU n'appartient pas à l'utilisateur.
   */
  async markRead(userId: number, id: string): Promise<MarkReadResultDto> {
    const result = await this.notificationRepository
      .createQueryBuilder()
      .update(Notification)
      .set({ readAt: () => 'COALESCE("read_at", now())' })
      .where('"id" = :id', { id })
      .andWhere('"user_id" = :userId', { userId })
      .execute();
    if (!result.affected) {
      throw new NotFoundException('Notification introuvable');
    }
    return { ok: true };
  }

  /** Marque toutes les notifications non lues de l'utilisateur. */
  async markAllRead(userId: number): Promise<MarkAllReadResultDto> {
    const result = await this.notificationRepository
      .createQueryBuilder()
      .update(Notification)
      .set({ readAt: () => 'now()' })
      .where('"user_id" = :userId', { userId })
      .andWhere('"read_at" IS NULL')
      .execute();
    return { updated: result.affected ?? 0 };
  }

  /**
   * Notifications de l'utilisateur avec l'acteur et le manga réduits aux
   * colonnes affichées (jamais l'email ni le hash d'un acteur en mémoire).
   */
  private pageQuery(userId: number): SelectQueryBuilder<Notification> {
    return this.notificationRepository
      .createQueryBuilder('n')
      .leftJoin('n.actor', 'actor')
      .addSelect(['actor.id', 'actor.username', 'actor.displayName'])
      .leftJoin('n.manga', 'manga')
      .addSelect([
        'manga.id',
        'manga.mu_id',
        'manga.title',
        'manga.medium_cover_url',
      ])
      .where('n.userId = :userId', { userId })
      .orderBy('n.createdAt', 'DESC')
      .addOrderBy('n.id', 'DESC');
  }

  /** Messages de partage et noms de groupe de la page, en 2 requêtes max. */
  private async loadLiveRefs(
    page: Notification[],
  ): Promise<NotificationLiveRefs> {
    const idsOf = (type: NotificationType, key: string): number[] => [
      ...new Set(
        page
          .filter((n) => n.type === type)
          .map((n) => readInt(n.data, key))
          .filter((id) => id > 0),
      ),
    ];
    const shareIds = idsOf(NotificationType.MangaShare, 'shareId');
    const groupIds = idsOf(NotificationType.ReadingGroupInvite, 'groupId');

    const [shares, groups] = await Promise.all([
      shareIds.length > 0
        ? this.shareRepository.find({
            where: { id: In(shareIds) },
            select: { id: true, message: true },
          })
        : Promise.resolve([] as MangaShare[]),
      groupIds.length > 0
        ? this.groupRepository.find({
            where: { id: In(groupIds) },
            select: { id: true, name: true },
          })
        : Promise.resolve([] as ReadingGroup[]),
    ]);
    return {
      shareMessages: new Map(shares.map((s) => [s.id, s.message ?? null])),
      groupNames: new Map(groups.map((g) => [g.id, g.name ?? null])),
    };
  }
}
