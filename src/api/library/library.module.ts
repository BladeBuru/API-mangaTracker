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
import { UserMangaChapterLog } from './user-manga-chapter-log.entity';
import { ChapterLogService } from './chapter-log.service';

@Module({
  imports: [
    forwardRef(() => MangasModule),
    HttpModule,
    TypeOrmModule.forFeature([Manga, User, UserManga, UserMangaChapterLog]),
  ],
  controllers: [LibraryController],
  providers: [UserService, LibraryService, UpdateMangaService, ChapterLogService],
  exports: [LibraryService, ChapterLogService],
})
export class LibraryModule {}
