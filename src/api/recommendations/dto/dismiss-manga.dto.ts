import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { DISMISSAL_REASONS, DismissalReason } from '../dismissal-reason.enum';

/**
 * Body de `POST /recommendations/dismissals/:muId`.
 *
 * La raison est **obligatoire** : un rejet sans raison serait un simple
 * booléen « masqué » et détruirait la seule information exploitable pour un
 * futur moteur de recommandation (distinguer « déjà lu, j'ai aimé » de
 * « pas intéressé »).
 */
export class DismissMangaDto {
  @ApiProperty({
    description:
      "Raison du rejet. `already_read` = déjà lu (affinité positive, rien à découvrir), `not_interested` = signal négatif de goût, `seen_elsewhere` = connu via l'animé / le drama / le film.",
    enum: DISMISSAL_REASONS,
    example: DismissalReason.SeenElsewhere,
  })
  @IsEnum(DismissalReason, {
    message: `reason doit valoir l'une des valeurs suivantes : ${DISMISSAL_REASONS.join(
      ', ',
    )}`,
  })
  reason: DismissalReason;
}

/**
 * Réponse de `POST /recommendations/dismissals/:muId` et élément de
 * `GET /recommendations/dismissals`.
 */
export class DismissalDto {
  @ApiProperty({
    description: 'Identifiant MangaUpdates du titre écarté',
    example: 12345,
  })
  muId: number;

  @ApiProperty({ description: 'Titre du manga écarté', example: 'One Piece' })
  title: string;

  @ApiProperty({
    description: 'Raison enregistrée',
    enum: DISMISSAL_REASONS,
    example: DismissalReason.SeenElsewhere,
  })
  reason: DismissalReason;

  @ApiProperty({
    description: 'Date du rejet (ISO 8601)',
    example: '2026-08-28T10:15:00.000Z',
  })
  createdAt: Date;
}
