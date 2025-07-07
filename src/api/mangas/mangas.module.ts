import { Module, forwardRef } from '@nestjs/common';
import { MangasController } from './mangas.controller';
import { MangasService } from './mangas.service';
import { HelperService } from './helper.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { UserManga } from './user-manga.entity';
import User from 'src/api/user/user.entity';
import { UserService } from 'src/api/user/user.service';
import { LibraryModule } from '../library/library.module';
import { LibraryService } from '../library/library.service';
import { UpdateMangaService } from './update-manga.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Manga, User, UserManga]),
    forwardRef(() => LibraryModule),
  ],
  controllers: [MangasController],
  providers: [
    MangasService,
    HelperService,
    UserService,
    LibraryService,
    UpdateMangaService,
  ],
  exports: [HelperService, UpdateMangaService],
})
export class MangasModule {}
