import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { AuthorsController } from './authors.controller';
import { AuthorsService } from './authors.service';
import { MuAuthorsClient } from './mu-authors.client';

/**
 * Pages auteur. `HttpService` vient du `GlobalHttpModule` (global) ; aucune
 * dépendance vers `MangasModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Manga])],
  controllers: [AuthorsController],
  providers: [AuthorsService, MuAuthorsClient],
})
export class AuthorsModule {}
