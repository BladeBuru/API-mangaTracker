import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserMangaChapterLog } from '../user-manga-chapter-log.entity';

/**
 * Body envoyé pour enregistrer une session de lecture (Phase 5).
 * `POST /library/:muId/chapter-log`.
 */
export class RecordChapterLogDto {
  @ApiProperty({ description: 'Numéro de chapitre (peut être décimal)', example: 42 })
  @IsNumber()
  @Type(() => Number)
  chapterNumber: number;

  @ApiPropertyOptional({ description: 'Bonus / OAV', example: false })
  @IsOptional()
  @IsBoolean()
  isBonus?: boolean;

  @ApiPropertyOptional({
    description: 'Position de scroll dans le webview (null = fin)',
    example: 12340,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  scrollPosition?: number;
}

/**
 * Body envoyé pour toggle skip / unskip un chapitre.
 * `PUT /library/:muId/chapter/:n/skip`.
 */
export class ToggleChapterSkipDto {
  @ApiProperty({ description: 'Skip (true) ou unskip (false)' })
  @IsBoolean()
  skipped: boolean;
}

/**
 * Réponse renvoyée pour une ligne du log de lecture.
 */
export class ChapterLogEntryDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  chapterNumber: number;

  @ApiProperty()
  isSkipped: boolean;

  @ApiProperty()
  isBonus: boolean;

  @ApiPropertyOptional({ nullable: true })
  scrollPosition: number | null;

  @ApiProperty({ description: 'ISO timestamp' })
  readAt: string;

  static fromEntity(log: UserMangaChapterLog): ChapterLogEntryDto {
    const dto = new ChapterLogEntryDto();
    dto.id = log.id;
    dto.chapterNumber = Number(log.chapterNumber);
    dto.isSkipped = log.isSkipped;
    dto.isBonus = log.isBonus;
    dto.scrollPosition = log.scrollPosition;
    dto.readAt = log.readAt.toISOString();
    return dto;
  }
}
