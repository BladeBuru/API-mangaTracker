import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LibraryController } from './library.controller';
import { UserService } from 'src/api/user/user.service';
import { LibraryService } from './library.service';
import { Manga } from 'src/api/mangas/manga.entity';
import User from 'src/api/user/user.entity';
import { UserManga } from 'src/api/mangas/user-manga.entity';
import { MangasModule } from 'src/api/mangas/mangas.module';
import { HttpModule } from '@nestjs/axios';
import { UpdateMangaService } from '../mangas/update-manga.service';
import { UserMangaChapterLog } from './user-manga-chapter-log.entity';
import { ChapterLogService } from './chapter-log.service';
import { MangaChapterReport } from './manga-chapter-report.entity';
import { ChapterReportService } from './chapter-report.service';
import { ChapterReportController } from './chapter-report.controller';
import { UserThrottlerGuard } from './user-throttler.guard';
import { RecoCacheModule } from '../recommendations/reco-cache.module';
import { ReadingStatusAutoUpdateService } from './reading-status-auto-update.service';
import { ReadingPositionController } from './reading-position.controller';
import { ReadingPositionService } from './reading-position.service';
import { ReadingPositionThrottlerGuard } from './reading-position-throttler.guard';

@Module({
  imports: [
    forwardRef(() => MangasModule),
    // Pour RecoCacheService : invalidation du cache recos d'un user sur
    // mutation de sa bibliothèque (hotfix-v0-10-1 US-4). Module autonome
    // sans dépendance → pas de cycle library → recommendations.
    RecoCacheModule,
    HttpModule,
    TypeOrmModule.forFeature([
      Manga,
      User,
      UserManga,
      UserMangaChapterLog,
      MangaChapterReport,
    ]),
  ],
  controllers: [
    LibraryController,
    ChapterReportController,
    // Reprise de lecture inter-appareils — sous-controller dédié :
    // LibraryController dépasse déjà les 200 lignes.
    ReadingPositionController,
  ],
  providers: [
    UserService,
    LibraryService,
    UpdateMangaService,
    ChapterLogService,
    ChapterReportService,
    // Bascule auto « à jour » → « en cours » quand le total de chapitres
    // augmente (consolidation communautaire ici ; sorties MU et refresh des
    // détails côté MangasModule).
    ReadingStatusAutoUpdateService,
    // Position de lecture en cours (reprise téléphone ↔ tablette).
    ReadingPositionService,
    // Gardes de rate-limit par utilisateur (providers pour bénéficier de
    // l'injection throttler + onModuleInit).
    UserThrottlerGuard,
    ReadingPositionThrottlerGuard,
  ],
  exports: [
    LibraryService,
    ChapterLogService,
    ChapterReportService,
    ReadingStatusAutoUpdateService,
    ReadingPositionService,
  ],
})
export class LibraryModule {}
