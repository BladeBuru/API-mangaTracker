import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReadingStatus } from '@/api/library/reading-status.enum';
import { Notification } from './notification.entity';
import { NotificationType } from './notification-type';

/**
 * Upsert ENSEMBLISTE des notifications « nouveaux chapitres » d'un manga
 * (`$1` = mu_id, `$2` = total avant la hausse, `$3`/`$4` = statuts éligibles).
 *
 * Une seule requête pour tous les lecteurs, quel que soit leur nombre :
 *  - éligibles : le manga est dans leur bibliothèque en « en cours » ou
 *    « à jour », et leur dernier chapitre terminé est sous le nouveau total
 *    (lu en base au moment de la requête — `total_chapters` est monotone) ;
 *  - au plus UNE notification non lue par (utilisateur, manga), garantie par
 *    l'index unique partiel `UQ_notification_new_chapters_unread` : une
 *    nouvelle hausse met à jour `latestChapter` / `readChapters`, conserve le
 *    `previousTotal` d'origine (« 40 → 47 » plutôt que « 46 → 47 ») et
 *    remonte la notification en tête (`created_at`) ;
 *  - `DISTINCT ON` : une éventuelle entrée bibliothèque en double ne doit pas
 *    faire toucher deux fois la même ligne (erreur PostgreSQL sinon).
 */
const UPSERT_NEW_CHAPTERS_SQL = `
  INSERT INTO "notification" ("user_id", "type", "mu_id", "data", "created_at")
  SELECT DISTINCT ON (um.user_id)
         um.user_id,
         '${NotificationType.NewChapters}',
         m.mu_id,
         jsonb_build_object(
           'latestChapter', m.total_chapters,
           'previousTotal', $2::int,
           'readChapters', um.user_read_chapters
         ),
         now()
  FROM "user_manga" um
  JOIN "manga" m ON m.mu_id = um.manga_id
  WHERE um.manga_id = $1
    AND um."readingStatus" IN ($3, $4)
    AND um.user_read_chapters < m.total_chapters
  ORDER BY um.user_id, um.user_read_chapters DESC
  ON CONFLICT ("user_id", "mu_id")
    WHERE "type" = '${NotificationType.NewChapters}' AND "read_at" IS NULL
  DO UPDATE SET
    "data" = jsonb_build_object(
      'latestChapter', EXCLUDED."data" -> 'latestChapter',
      'previousTotal', COALESCE(
        "notification"."data" -> 'previousTotal',
        EXCLUDED."data" -> 'previousTotal'
      ),
      'readChapters', EXCLUDED."data" -> 'readChapters'
    ),
    "created_at" = EXCLUDED."created_at"
  RETURNING "id"
`;

/**
 * Écriture des notifications in-app, appelée par les services métier
 * (amis, partage, groupes de lecture, sorties de chapitres).
 *
 * **Best-effort, sans exception** : une notification est un effet
 * secondaire. Toute erreur est journalisée et avalée — l'action principale
 * (demande d'ami, partage, mise à jour du total…) ne doit JAMAIS échouer à
 * cause d'elle.
 */
@Injectable()
export class NotificationProducerService {
  private readonly logger = new Logger(NotificationProducerService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
  ) {}

  /** Demande d'amitié reçue → `friend_request` pour le destinataire. */
  async friendRequestSent(
    friendshipId: number,
    requesterId: number,
    addresseeId: number,
  ): Promise<void> {
    await this.bestEffort('friend_request', undefined, async () => {
      await this.notificationRepository.insert({
        userId: addresseeId,
        actorId: requesterId,
        type: NotificationType.FriendRequest,
        data: { friendshipId },
      });
    });
  }

  /**
   * Demande acceptée (explicitement ou par demande croisée) →
   * `friend_accepted` pour le demandeur d'origine, et la `friend_request`
   * de celui qui accepte passe en lue.
   */
  async friendRequestAccepted(
    friendshipId: number,
    requesterId: number,
    accepterId: number,
  ): Promise<void> {
    await this.bestEffort('friend_accepted', undefined, async () => {
      await this.notificationRepository.insert({
        userId: requesterId,
        actorId: accepterId,
        type: NotificationType.FriendAccepted,
        data: { friendshipId },
      });
    });
    await this.friendRequestHandled(friendshipId, accepterId);
  }

  /** La demande a été traitée (acceptée, bloquée…) → notification lue. */
  async friendRequestHandled(
    friendshipId: number,
    addresseeId: number,
  ): Promise<void> {
    await this.bestEffort('friend_request lue', undefined, async () => {
      await this.notificationRepository
        .createQueryBuilder()
        .update(Notification)
        .set({ readAt: () => 'now()' })
        .where('"user_id" = :addresseeId', { addresseeId })
        .andWhere('"type" = :type', { type: NotificationType.FriendRequest })
        .andWhere('"read_at" IS NULL')
        .andWhere('"data" @> CAST(:match AS jsonb)', {
          match: JSON.stringify({ friendshipId }),
        })
        .execute();
    });
  }

  /**
   * Demande annulée par son auteur ou refusée (relation supprimée) → la
   * `friend_request` disparaît : elle pointerait vers une demande qui
   * n'existe plus.
   */
  async friendRequestWithdrawn(
    friendshipId: number,
    addresseeId: number,
  ): Promise<void> {
    await this.bestEffort('friend_request retirée', undefined, async () => {
      await this.notificationRepository
        .createQueryBuilder()
        .delete()
        .from(Notification)
        .where('"user_id" = :addresseeId', { addresseeId })
        .andWhere('"type" = :type', { type: NotificationType.FriendRequest })
        .andWhere('"data" @> CAST(:match AS jsonb)', {
          match: JSON.stringify({ friendshipId }),
        })
        .execute();
    });
  }

  /** Partages réellement créés → un `manga_share` par destinataire. */
  async mangaShared(
    senderId: number,
    muId: string,
    shares: Array<{ id: number; addresseeId: number }>,
  ): Promise<void> {
    if (shares.length === 0) return;
    await this.bestEffort('manga_share', undefined, async () => {
      await this.notificationRepository.insert(
        shares.map((share) => ({
          userId: share.addresseeId,
          actorId: senderId,
          type: NotificationType.MangaShare,
          muId,
          data: { shareId: share.id },
        })),
      );
    });
  }

  /** Boîte de partages consultée (`mark-seen`) → `manga_share` lues. */
  async mangaSharesSeen(userId: number): Promise<void> {
    await this.bestEffort('manga_share lues', undefined, async () => {
      await this.notificationRepository
        .createQueryBuilder()
        .update(Notification)
        .set({ readAt: () => 'now()' })
        .where('"user_id" = :userId', { userId })
        .andWhere('"type" = :type', { type: NotificationType.MangaShare })
        .andWhere('"read_at" IS NULL')
        .execute();
    });
  }

  /** Ajout à un groupe de lecture → un `reading_group_invite` par invité. */
  async readingGroupInvites(
    inviterId: number,
    groupId: number,
    muId: string,
    inviteeIds: number[],
  ): Promise<void> {
    const invitees = [...new Set(inviteeIds)].filter((id) => id !== inviterId);
    if (invitees.length === 0) return;
    await this.bestEffort('reading_group_invite', undefined, async () => {
      await this.notificationRepository.insert(
        invitees.map((userId) => ({
          userId,
          actorId: inviterId,
          type: NotificationType.ReadingGroupInvite,
          muId,
          data: { groupId },
        })),
      );
    });
  }

  /**
   * Hausse du total de chapitres de `muId` → `new_chapters` pour chaque
   * lecteur en retard (une requête, cf. `UPSERT_NEW_CHAPTERS_SQL`).
   *
   * @param previousTotal Total AVANT la hausse.
   * @returns Nombre de notifications créées ou mises à jour.
   */
  async newChapters(
    muId: number | string,
    previousTotal: number,
  ): Promise<number> {
    return this.bestEffort('new_chapters', 0, async () => {
      const rows: unknown[] = await this.notificationRepository.query(
        UPSERT_NEW_CHAPTERS_SQL,
        [
          String(muId),
          Math.max(0, Math.trunc(Number(previousTotal) || 0)),
          ReadingStatus.Reading,
          ReadingStatus.CaughtUp,
        ],
      );
      const count = Array.isArray(rows) ? rows.length : 0;
      if (count > 0) {
        this.logger.log(
          `Manga ${muId} : ${count} notification(s) « nouveaux chapitres »`,
        );
      }
      return count;
    });
  }

  private async bestEffort<T>(
    label: string,
    fallback: T,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (err) {
      this.logger.error(
        `[notifications] échec d'écriture (${label}) — action principale non affectée : ${
          (err as Error)?.message ?? err
        }`,
      );
      return fallback;
    }
  }
}
