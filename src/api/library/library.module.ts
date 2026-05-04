import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LibraryController } from './library.controller';
import { UserService } from 'src/api/user/user.service';
import { LibraryService } from './library.service';
import { Manga } from 'src/api/mangas/manga.entity';
import User from 'src/api/user/user.entity';
import { UserManga } from 'src/api/mangas/user-manga.entity';
import { MangasModule } from 'src/api/mangas/mangas.module';
import { HttpModule } from '@nestjs/axios';
import { UpdateMangaService } from '../mangas/update-manga.service';

@Module({
  imports: [
    forwardRef(() => MangasModule),
    HttpModule,
    TypeOrmModule.forFeature([Manga, User, UserManga]),
  ],
  controllers: [LibraryController],
  providers: [UserService, LibraryService, UpdateMangaService],
  exports: [LibraryService],
})
export class LibraryModule {}
