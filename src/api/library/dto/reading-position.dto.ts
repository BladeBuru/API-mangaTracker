import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNumber, Max, Min } from 'class-validator';

/**
 * Corps de `PUT /library/reading-position` — où l'utilisateur en est DANS un
 * chapitre, pour reprendre au même endroit sur un autre appareil.
 */
export class UpdateReadingPositionDto {
  @ApiProperty({
    description: 'Identifiant MangaUpdates de la série (`manga.mu_id`).',
    example: 70668,
  })
  @IsInt()
  muId: number;

  @ApiProperty({
    description:
      'Chapitre en cours de lecture (entier ≥ 0). Distinct de ' +
      '`readChapters` (dernier chapitre TERMINÉ) : on peut avoir terminé 12 ' +
      'chapitres et être à 40 % du 13e. Les chapitres décimaux (12.5) ne ' +
      'sont pas gérés par le pointeur de reprise (journal de lecture ' +
      '`POST /library/:muId/chapter-log` pour cet usage).',
    example: 13,
  })
  @IsInt()
  @Min(0)
  chapter: number;

  @ApiProperty({
    description:
      'Avancement dans le chapitre, en pourcentage (0-100). Un pourcentage ' +
      "et non des pixels : la hauteur rendue d'un chapitre dépend de " +
      "l'écran. Les valeurs fractionnaires sont acceptées et arrondies à " +
      "l'entier le plus proche.",
    minimum: 0,
    maximum: 100,
    example: 42,
  })
  @IsNumber()
  @Min(0)
  @Max(100)
  positionPercent: number;
}

/**
 * Accusé de réception de `PUT /library/reading-position`.
 *
 * Toujours `{ ok: true }` en 200 : l'écriture est de la télémétrie de
 * confort, jamais bloquante. Une position obsolète volontairement ignorée
 * (appareil en retard) et une écriture effective renvoient la même chose —
 * le client n'a aucune décision à prendre là-dessus.
 */
export class ReadingPositionAckDto {
  @ApiProperty({ example: true })
  ok: boolean;
}

/** Réponse de `GET /library/:muId/reading-position` (204 si aucune position). */
export class ReadingPositionDto {
  @ApiProperty({ description: 'Chapitre en cours de lecture.', example: 13 })
  chapter: number;

  @ApiProperty({
    description: 'Avancement dans le chapitre (0-100).',
    example: 42,
  })
  positionPercent: number;

  @ApiProperty({
    description:
      'Horodatage serveur ISO 8601 de la dernière écriture acceptée.',
    example: '2026-09-06T12:34:56.000Z',
  })
  updatedAt: string;
}
