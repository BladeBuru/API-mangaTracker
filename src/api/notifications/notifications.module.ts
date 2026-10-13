import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MangaShare } from '@/api/sharing/manga-share.entity';
import { ReadingGroup } from '@/api/sharing/reading-group.entity';
import { Notification } from './notification.entity';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationProducerService } from './notification-producer.service';
import { NotificationRetentionService } from './notification-retention.service';

/**
 * Centre de notifications in-app unifié (2026-10).
 *
 * Module FEUILLE : il n'importe aucun module métier (seulement des
 * entités), si bien que Friends, Sharing, Library et Mangas peuvent tous
 * l'importer pour produire des notifications sans créer de cycle.
 * `NotificationProducerService` est le seul point d'écriture exporté.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Notification, MangaShare, ReadingGroup])],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationProducerService,
    NotificationRetentionService,
  ],
  exports: [NotificationProducerService],
})
export class NotificationsModule {}
