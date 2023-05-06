import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LibraryController } from './library.controller';
import { MangasService } from 'src/mangas/mangas.service';
import { UserService } from 'src/user/user.service';
import { LibraryService } from './library.service';
import { Manga } from 'src/mangas/manga.entity';
import User from 'src/user/user.entity';
import { UserManga } from 'src/mangas/user-manga.entity';
import { MangasModule } from 'src/mangas/mangas.module';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [
    MangasModule,
    HttpModule,
    TypeOrmModule.forFeature([Manga, User, UserManga]),
  ],
  controllers: [LibraryController],
  providers: [MangasService, UserService, LibraryService],
})
export class LibraryModule {}
