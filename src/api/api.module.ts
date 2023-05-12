import { Module } from '@nestjs/common';
import { UserModule } from './user/userModule';
import { GlobalHttpModule } from '@/api/config/http.module';
import { LibraryModule } from '@/api/library/library.module';
import { MangasModule } from '@/api/mangas/mangas.module';
import {FavoritesModule} from "@/api/favorites/favoritesModule";

@Module({
  imports: [UserModule, GlobalHttpModule, LibraryModule, MangasModule,FavoritesModule],
})
export class ApiModule {}
