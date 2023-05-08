import { Module } from '@nestjs/common';
import { MangasController } from './mangas.controller';
import { MangasService } from './mangas.service';
import { HelperService } from './helper.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { UserManga } from './user-manga.entity';
import User from 'src/api/user/user.entity';
import { UserService } from 'src/api/user/user.service';

@Module({
  imports: [TypeOrmModule.forFeature([Manga, User, UserManga])],
  controllers: [MangasController],
  providers: [MangasService, HelperService, UserService],
  exports: [HelperService],
})
export class MangasModule {}
