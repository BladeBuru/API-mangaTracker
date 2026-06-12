import { Module } from '@nestjs/common';
import { RecoCacheService } from './reco-cache.service';

/**
 * Micro-module autonome pour le cache des recommandations
 * (hotfix-v0-10-1 US-4).
 *
 * Sans dépendance → importable par RecommendationModule, LibraryModule ET
 * MangasModule (qui re-déclare LibraryService dans ses providers) sans
 * créer de cycle de modules. Le singleton est partagé entre tous les
 * contextes d'injection.
 */
@Module({
  providers: [RecoCacheService],
  exports: [RecoCacheService],
})
export class RecoCacheModule {}
