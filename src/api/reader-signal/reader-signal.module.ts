import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CatalogSyncState } from '@/api/mangas/catalog-sync-state.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { MuJobLockModule } from '@/api/mangas/mu-job-lock.module';
import { MuListsClient } from './mu-lists.client';
import { ReaderCooccurrence } from './reader-cooccurrence.entity';
import { ReaderHashService } from './reader-hash.service';
import { ReaderProfile } from './reader-profile.entity';
import { ReaderSignalAggregateService } from './reader-signal-aggregate.service';
import { ReaderSignalCollectService } from './reader-signal-collect.service';
import { ReaderSignalPriorityService } from './reader-signal-priority.service';
import { ReaderSignalWriterService } from './reader-signal-writer.service';
import { ReaderSignal } from './reader-signal.entity';

/**
 * Collecte anonymisée du signal de lecture public MangaUpdates.
 *
 * **Aucun controller, aucune route.** Le module s'arrête à la donnée
 * collectée et agrégée : brancher `reader_cooccurrence` sur le moteur de
 * recommandation est un chantier distinct (voir `progress.md`). Exporter le
 * service d'agrégation suffit à ce que le moteur puisse, plus tard,
 * déclencher un recalcul.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReaderSignal,
      ReaderProfile,
      ReaderCooccurrence,
      // Lecture seule : filtrage des séries hors catalogue, ciblage de la
      // découverte, ventilation par type dans les logs.
      Manga,
      // Curseurs de découverte, lignes `reader-signal:disc:<seau>`.
      CatalogSyncState,
    ]),
    // Instance UNIQUE du verrou MU, partagée avec les jobs de `MangasModule`.
    MuJobLockModule,
  ],
  providers: [
    MuListsClient,
    ReaderHashService,
    ReaderSignalPriorityService,
    ReaderSignalWriterService,
    ReaderSignalCollectService,
    ReaderSignalAggregateService,
  ],
  exports: [ReaderSignalAggregateService],
})
export class ReaderSignalModule {}
