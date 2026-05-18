import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MangaComment } from '../manga-comment.entity';

/**
 * Tri possible pour la liste des commentaires (top-level uniquement).
 *  - `recent` : par `createdAt DESC` (par défaut).
 *  - `top` : par nombre de replies décroissant — proxy "trending".
 */
export enum CommentSort {
  Recent = 'recent',
  Top = 'top',
}

export class CreateCommentDto {
  @ApiProperty({
    description: 'Contenu (3-2000 chars)',
    example: "Vraiment top, mais la fin du chapitre 50 m'a déçu...",
  })
  @IsString()
  @Length(3, 2000)
  content: string;

  @ApiPropertyOptional({
    description: 'Note 1-10 (review attachée au commentaire)',
    example: 8,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  rating?: number;
}

export class UpdateCommentDto {
  @ApiProperty({ description: 'Contenu (3-2000 chars)' })
  @IsString()
  @Length(3, 2000)
  content: string;

  @ApiPropertyOptional({ description: 'Note 1-10' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  rating?: number;
}

export class ListCommentsQueryDto {
  @ApiPropertyOptional({ enum: CommentSort, default: CommentSort.Recent })
  @IsOptional()
  @IsEnum(CommentSort)
  sort?: CommentSort = CommentSort.Recent;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;
}

export class ReportCommentDto {
  @ApiPropertyOptional({
    description: 'Raison du signalement (libre, 64 chars max)',
    example: 'spam',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  reason?: string;
}

/**
 * Représentation d'un commentaire renvoyée par l'API. Contient les
 * infos de l'auteur (avatar, displayName) pour éviter un join supplémentaire
 * côté Flutter.
 */
export class CommentDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  content: string;

  @ApiPropertyOptional({ nullable: true })
  rating?: number | null;

  @ApiProperty()
  authorId: number;

  @ApiProperty()
  authorUsername: string;

  @ApiPropertyOptional({ nullable: true })
  authorDisplayName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  authorAvatarUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  parentCommentId?: number | null;

  @ApiProperty()
  isDeleted: boolean;

  @ApiProperty({ description: 'Nombre de réponses directes' })
  replyCount: number;

  @ApiProperty({ description: 'ISO timestamp' })
  createdAt: string;

  @ApiProperty({ description: 'ISO timestamp' })
  updatedAt: string;

  static fromEntity(c: MangaComment, replyCount = 0): CommentDto {
    const dto = new CommentDto();
    dto.id = c.id;
    // Soft delete : on masque le contenu mais on conserve la structure.
    dto.content = c.isDeleted ? '[supprimé]' : c.content;
    dto.rating = c.isDeleted ? null : c.rating;
    dto.authorId = c.user?.id;
    dto.authorUsername = c.user?.username ?? '';
    dto.authorDisplayName = c.user?.displayName ?? null;
    dto.authorAvatarUrl = c.user?.avatarUrl ?? null;
    dto.parentCommentId = c.parentComment?.id ?? null;
    dto.isDeleted = c.isDeleted;
    dto.replyCount = replyCount;
    dto.createdAt = c.createdAt.toISOString();
    dto.updatedAt = c.updatedAt.toISOString();
    return dto;
  }
}
