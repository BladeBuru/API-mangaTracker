import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification } from './notification.entity';

const DAY_MS = 24 * 3600 * 1000;

/**
 * Purge nocturne des notifications (minimisation RGPD, table bornée).
 *
 * - notification LUE de plus de 30 jours (date de création) → supprimée ;
 * - toute notification de plus de 90 jours → supprimée, lue ou non.
 *
 * Requête BDD seule, aucun appel MangaUpdates : pas de verrou
 * `MuJobLockService`. Créneau 03:15, entre les sorties (02:00) et le
 * catalogue (03:30), loin des pics d'usage.
 */
@Injectable()
export class NotificationRetentionService {
  private readonly logger = new Logger(NotificationRetentionService.name);

  /** Conservation d'une notification lue. */
  static readonly READ_RETENTION_DAYS = 30;
  /** Conservation maximale, lue ou non. */
  static readonly MAX_RETENTION_DAYS = 90;

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
  ) {}

  @Cron('0 15 3 * * *')
  async handleNightlyPurge(): Promise<void> {
    await this.purge();
  }

  /**
   * Point d'entrée testable. Best-effort : une erreur est journalisée, la
   * purge reprendra la nuit suivante.
   *
   * @returns Nombre de notifications supprimées.
   */
  async purge(now: Date = new Date()): Promise<number> {
    const readCutoff = new Date(
      now.getTime() - NotificationRetentionService.READ_RETENTION_DAYS * DAY_MS,
    );
    const maxCutoff = new Date(
      now.getTime() - NotificationRetentionService.MAX_RETENTION_DAYS * DAY_MS,
    );
    try {
      const result = await this.notificationRepository
        .createQueryBuilder()
        .delete()
        .from(Notification)
        .where(
          '("read_at" IS NOT NULL AND "created_at" < :readCutoff) OR "created_at" < :maxCutoff',
          { readCutoff, maxCutoff },
        )
        .execute();
      const deleted = Number(result?.affected ?? 0);
      if (deleted > 0) {
        this.logger.log(`[notifications] ${deleted} notification(s) purgée(s)`);
      }
      return deleted;
    } catch (err) {
      this.logger.error(
        `[notifications] échec de la purge : ${(err as Error)?.message ?? err}`,
      );
      return 0;
    }
  }
}
