import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { MangasModule } from '@/api/mangas/mangas.module';
import { RecommendationService } from './recommendation.service';
import { RecommendationController } from './recommendation.controller';
import { RecoCacheModule } from './reco-cache.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserManga, MangaRecommendation, Manga]),
    MangasModule,
    // Cache user-level (hotfix-v0-10-1 US-4) — module autonome, importé
    // aussi par LibraryModule/MangasModule pour l'invalidation (pas de cycle).
    RecoCacheModule,
  ],
  controllers: [RecommendationController],
  providers: [RecommendationService],
  exports: [RecommendationService],
})
export class RecommendationModule {}
