import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import User from '@/api/user/user.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { FavoriteController } from '@/api/favorites/favorite.controller';
import { FavoriteService } from '@/api/favorites/favorite.service';
import { UserMangaFavorite } from '@/api/favorites/user-manga-favorite.entity';
import { UpdateMangaService } from '../mangas/update-manga.service';
import { MangasService } from '../mangas/mangas.service';
import { MangasModule } from '../mangas/mangas.module';

@Module({
  imports: [
    MangasModule,
    TypeOrmModule.forFeature([Manga, User, UserMangaFavorite]),
  ],
  providers: [FavoriteService, UpdateMangaService, MangasService],
  controllers: [FavoriteController],
})
export class FavoritesModule {}
