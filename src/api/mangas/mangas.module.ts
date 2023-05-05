import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { MangasService } from './mangas.service';
import {UserService} from "@/api/user/user.service";
import User from "@/api/user/user.entity";
import {MangaController} from "@/api/mangas/manga.controller";
import {UserFavoriteManga} from "@/api/user/userFavoris.entity";

@Module({
  imports: [TypeOrmModule.forFeature([Manga,User,UserFavoriteManga])],
  providers: [MangasService,UserService],
  controllers: [MangaController],
})
export class MangasModule {}
