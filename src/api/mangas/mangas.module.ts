import { Module, forwardRef } from '@nestjs/common';
import { MangasController } from './mangas.controller';
import { MangaCoversController } from './manga-covers.controller';
import { MangasService } from './mangas.service';
import { HelperService } from './helper.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { MangaRecommendation } from './manga-recommendation.entity';
import { UserManga } from './user-manga.entity';
import User from 'src/api/user/user.entity';
import { UserService } from 'src/api/user/user.service';
import { LibraryModule } from '../library/library.module';
import { LibraryService } from '../library/library.service';
import { ChapterLogService } from '../library/chapter-log.service';
import { ChapterReportService } from '../library/chapter-report.service';
import { UserMangaChapterLog } from '../library/user-manga-chapter-log.entity';
import { MangaChapterReport } from '../library/manga-chapter-report.entity';
import { UpdateMangaService } from './update-manga.service';
import { MangaSyncService } from './sync-manga.service';
import { CatalogSyncService } from './catalog-sync.service';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { CoverProxyService } from './cover-proxy.service';
import { RecoCacheModule } from '../recommendations/reco-cache.module';
import { MangaTranslation } from './manga-translation.entity';
import { DescriptionTranslationService } from './translation/description-translation.service';
import { DeeplProvider } from './translation/deepl.provider';
import { GtxProvider } from './translation/gtx.provider';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Manga,
      MangaRecommendation,
      MangaTranslation,
      CatalogSyncState,
      User,
      UserManga,
      UserMangaChapterLog,
      MangaChapterReport,
    ]),
    forwardRef(() => LibraryModule),
    // LibraryService est re-déclaré dans les providers ci-dessous → son
    // injection de RecoCacheService doit être résolue DANS ce contexte
    // (hotfix-v0-10-1 US-4). Module autonome, pas de cycle. Idem pour
    // ChapterLogService / ChapterReportService (chantiers A & B) et leurs
    // entités dans le forFeature ci-dessus.
    RecoCacheModule,
  ],
  controllers: [MangasController, MangaCoversController],
  providers: [
    MangasService,
    HelperService,
    UserService,
    LibraryService,
    ChapterLogService,
    ChapterReportService,
    UpdateMangaService,
    MangaSyncService,
    CatalogSyncService,
    CoverProxyService,
    DescriptionTranslationService,
    DeeplProvider,
    GtxProvider,
  ],
  exports: [HelperService, UpdateMangaService, MangaSyncService, MangasService],
})
export class MangasModule {}
