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
    description:
      'Temps de lecture estimé en minutes (4 min/chapitre en moyenne)',
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

  @ApiProperty({
    description:
      'Top genres avec compteurs (Stats v2 — pour les graphiques). ' +
      'Superset de `topGenres` (conservé pour compat).',
    example: [
      { genre: 'Action', count: 24 },
      { genre: 'Romance', count: 17 },
    ],
  })
  genreCounts: Array<{ genre: string; count: number }>;

  @ApiProperty({
    description:
      'Historique des dernières sessions de lecture (journal chapter_log, ' +
      'max 20, plus récentes en premier). Vide si le journal ne contient rien.',
    example: [
      {
        muId: 12345,
        mangaTitle: 'One Piece',
        chapterNumber: 1118,
        isBonus: false,
        readAt: '2026-06-10T21:14:00.000Z',
      },
    ],
  })
  readingHistory: Array<{
    muId: number;
    mangaTitle: string;
    chapterNumber: number;
    isBonus: boolean;
    readAt: string;
  }>;

  @ApiProperty({
    description:
      'Chapitres lus par semaine (8 dernières semaines, journal chapter_log). ' +
      'Clé = lundi de la semaine en ISO date (yyyy-MM-dd), valeur = nombre ' +
      'de sessions de lecture (skips exclus).',
    example: { '2026-06-08': 12, '2026-06-01': 7 },
  })
  chaptersPerWeek: Record<string, number>;
}
