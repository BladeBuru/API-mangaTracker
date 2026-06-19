import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { MangaComment } from './manga-comment.entity';
import { CommentReport } from './comment-report.entity';
import { CommentsService } from './comments.service';
import { CommentsController } from './comments.controller';

/**
 * Module Commentaires (Phase 7). Expose CRUD complet + threading +
 * signalements pour la modération future.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Manga, MangaComment, CommentReport])],
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
