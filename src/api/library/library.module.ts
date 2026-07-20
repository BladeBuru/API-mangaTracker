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
  controllers: [LibraryController, ChapterReportController],
  providers: [
    UserService,
    LibraryService,
    UpdateMangaService,
    ChapterLogService,
    ChapterReportService,
    // Garde de rate-limit par utilisateur pour la route report-chapters
    // (provider pour bénéficier de l'injection throttler + onModuleInit).
    UserThrottlerGuard,
  ],
  exports: [LibraryService, ChapterLogService, ChapterReportService],
})
export class LibraryModule {}
