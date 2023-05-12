import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import User from "@/api/user/user.entity";
import {Manga} from "@/api/mangas/manga.entity";
import {FavoriteController} from "@/api/favorites/favorite.controller";
import {FavoriteService} from "@/api/favorites/favorite.service";
import {UserMangaFavorite} from "@/api/favorites/user-manga-favorite.entity";


@Module({
    imports: [TypeOrmModule.forFeature([Manga,User,UserMangaFavorite])],
    providers: [FavoriteService],
    controllers: [FavoriteController],
})
export class FavoritesModule {}