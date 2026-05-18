import { ApiProperty } from '@nestjs/swagger';

/**
 * Statistiques agrégées de l'utilisateur — Phase 2.
 *
 * Calculées à la volée depuis `user_manga` (statuts, chapitres lus) +
 * `manga.genres` (top genres). Pas de cache côté serveur pour MVP — si
 * la charge augmente, on cachera via Redis (TTL 1h, invalidate sur add/
 * remove/update de la biblio).
 */
export class UserStatsDto {
  @ApiProperty({
    description: 'Nombre de mangas par statut de lecture',
    example: {
      reading: 12,
      completed: 34,
      caughtUp: 5,
      readLater: 8,
    },
  })
  mangasByStatus: Record<string, number>;

  @ApiProperty({
    description: 'Total des chapitres lus sur toute la biblio',
    example: 1245,
  })
  totalChaptersRead: number;

  @ApiProperty({
    description: "Temps de lecture estimé en minutes (4 min/chapitre en moyenne)",
    example: 4980,
  })
  estimatedReadingTimeMinutes: number;

  @ApiProperty({
    description: 'Top 5 des genres les plus présents dans la biblio',
    example: ['Action', 'Romance', 'Comedy', 'Drama', 'Fantasy'],
    type: [String],
  })
  topGenres: string[];

  @ApiProperty({
    description: "Date de dernière mise à jour d'un manga (ISO)",
    example: '2026-05-10T18:42:00.000Z',
    nullable: true,
  })
  lastReadAt: string | null;

  @ApiProperty({
    description:
      'Taux de complétion : completed / (reading + completed + caughtUp + dropped). 0-1.',
    example: 0.42,
  })
  completionRate: number;

  @ApiProperty({
    description: 'Date de création du compte (ISO)',
    example: '2024-08-15T12:30:00.000Z',
  })
  accountCreatedAt: string;

  @ApiProperty({
    description: 'Nombre total de mangas dans la biblio',
    example: 59,
  })
  totalMangas: number;
}
