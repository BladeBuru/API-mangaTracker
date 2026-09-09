import { Module } from '@nestjs/common';
import { UserModule } from './user/user.module';
import { GlobalHttpModule } from '@/api/config/http.module';
import { LibraryModule } from '@/api/library/library.module';
import { MangasModule } from '@/api/mangas/mangas.module';
import { ReaderSignalModule } from './reader-signal/reader-signal.module';
import { RecommendationModule } from './recommendations/recommendation.module';
import { WellKnownModule } from './well-known/well-known.module';
import { FriendsModule } from './friends/friends.module';
import { CommentsModule } from './comments/comments.module';
import { SharingModule } from './sharing/sharing.module';

@Module({
  imports: [
    UserModule,
    GlobalHttpModule,
    LibraryModule,
    MangasModule,
    // Collecte nocturne du signal de lecture public MangaUpdates
    // (anonymisé) — aucune route exposée, cf. `reader-signal.module.ts`.
    ReaderSignalModule,
    RecommendationModule,
    WellKnownModule,
    FriendsModule,
    CommentsModule,
    SharingModule,
  ],
})
export class ApiModule {}
