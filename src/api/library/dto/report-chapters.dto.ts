import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Body de `POST /library/:muId/report-chapters` (Chantier A).
 *
 * Le total signalé doit être strictement supérieur au total officiel et
 * borné à `total + MAX_REPORT_DELTA` (garde-fou anti-typo) — validé côté
 * service (`ChapterReportService.reportMoreChapters`).
 */
export class ReportChaptersDto {
  @ApiProperty({
    description:
      'Total de chapitres constaté par l’utilisateur (doit être > au total officiel connu, et ≤ total + 200)',
    example: 120,
  })
  @IsInt()
  @Min(1)
  @Type(() => Number)
  reportedTotal: number;
}

/**
 * Réponse de `POST /library/:muId/report-chapters`.
 */
export class ReportChaptersResultDto {
  @ApiProperty({ description: 'Total signalé enregistré', example: 120 })
  reportedTotal: number;

  @ApiProperty({
    description:
      'Total effectif pour cet utilisateur après le report : max(total officiel, total signalé)',
    example: 120,
  })
  effectiveTotalChapters: number;

  @ApiProperty({
    description:
      'true si le report a déclenché une consolidation communautaire (bump du total officiel)',
    example: false,
  })
  consolidated: boolean;
}
