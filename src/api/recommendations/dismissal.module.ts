import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { UserMangaDismissal } from './user-manga-dismissal.entity';
import { DismissalService } from './dismissal.service';
import { RecoCacheModule } from './reco-cache.module';

/**
 * Module autonome des rejets « pas intéressé / déjà vu ».
 *
 * Ne dépend que de TypeORM et de `RecoCacheModule` (lui-même sans
 * dépendance) → importable par `RecommendationModule` ET par `MangasModule`
 * (recos de la fiche détail) sans créer de cycle de modules. Même stratégie
 * que `RecoCacheModule`.
 *
 * Le controller est déclaré dans `RecommendationModule` (les routes
 * appartiennent au domaine Recommendations) ; ici on ne fournit que le
 * service, seul point d'accès aux `mu_id` exclus.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([UserMangaDismissal, Manga]),
    RecoCacheModule,
  ],
  providers: [DismissalService],
  exports: [DismissalService],
})
export class DismissalModule {}
