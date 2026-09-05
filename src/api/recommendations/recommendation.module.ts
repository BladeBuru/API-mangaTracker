import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { MangasModule } from '@/api/mangas/mangas.module';
import { RecommendationService } from './recommendation.service';
import { RecommendationController } from './recommendation.controller';
import { CatalogCandidateService } from './catalog-candidate.service';
import { GenreSectionService } from './genre-section.service';
import { SleeperHitsService } from './sleeper-hits.service';
import { RecommendationDtoBuilderService } from './recommendation-dto-builder.service';
import { RecoCacheModule } from './reco-cache.module';
import { DismissalModule } from './dismissal.module';
import { DismissalController } from './dismissal.controller';
import { DismissalThrottlerGuard } from './dismissal-throttler.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserManga, MangaRecommendation, Manga]),
    MangasModule,
    // Cache user-level (hotfix-v0-10-1 US-4) — module autonome, importé
    // aussi par LibraryModule/MangasModule pour l'invalidation (pas de cycle).
    RecoCacheModule,
    // Rejets « pas intéressé / déjà vu » — source unique des mu_id exclus
    // de TOUS les chemins de reco. Module autonome (comme RecoCacheModule),
    // importé aussi par MangasModule sans créer de cycle.
    DismissalModule,
  ],
  controllers: [RecommendationController, DismissalController],
  providers: [
    RecommendationService,
    CatalogCandidateService,
    GenreSectionService,
    // Extraits de RecommendationService (2026-09-05, limite 600 lignes) :
    // sleepers + cold start, et construction des cartes de la liste plate
    // (prorata du profil de type).
    SleeperHitsService,
    RecommendationDtoBuilderService,
    // Garde de rate-limit par utilisateur des routes de rejet (provider
    // pour bénéficier de l'injection throttler + onModuleInit).
    DismissalThrottlerGuard,
  ],
  exports: [RecommendationService],
})
export class RecommendationModule {}
