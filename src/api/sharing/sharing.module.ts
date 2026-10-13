import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { MangaShare } from './manga-share.entity';
import { ReadingGroup, ReadingGroupMember } from './reading-group.entity';
import { UserFriendship } from '../friends/user-friendship.entity';
import { SharingService } from './sharing.service';
import { SharingController } from './sharing.controller';
import { ReadingGroupsService } from './reading-groups.service';
import { ReadingGroupsController } from './reading-groups.controller';
import { MangaShareThrottlerGuard } from './manga-share-throttler.guard';
import { ReadingGroupWriteThrottlerGuard } from './reading-group-write-throttler.guard';
import { NotificationsModule } from '@/api/notifications/notifications.module';

/**
 * Module Sharing (Phase 8 + 8.3). Partage de manga entre amis +
 * reading groups (lecture à deux) avec progression cross-membres.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Manga,
      UserManga,
      MangaShare,
      ReadingGroup,
      ReadingGroupMember,
      UserFriendship,
    ]),
    // Partages et invitations → centre de notifications (module feuille).
    NotificationsModule,
  ],
  controllers: [SharingController, ReadingGroupsController],
  providers: [
    SharingService,
    ReadingGroupsService,
    // Gardes de quota par utilisateur (injection throttler + onModuleInit).
    MangaShareThrottlerGuard,
    ReadingGroupWriteThrottlerGuard,
  ],
  exports: [SharingService, ReadingGroupsService],
})
export class SharingModule {}
