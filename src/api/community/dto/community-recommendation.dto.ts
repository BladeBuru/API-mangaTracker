import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Une œuvre recommandée depuis une fiche, votes MangaUpdates + Manga Tracker. */
export class CommunityRecommendationItemDto {
  @ApiProperty({ example: 55099564912 })
  muId: number;

  @ApiProperty({ example: 'Naruto' })
  title: string;

  @ApiPropertyOptional({ example: 1999, nullable: true })
  year: number | null;

  @ApiPropertyOptional({ nullable: true })
  smallCoverUrl: string | null;

  @ApiPropertyOptional({ nullable: true })
  mediumCoverUrl: string | null;

  @ApiPropertyOptional({ example: 8.1, nullable: true })
  rating: number | null;

  @ApiPropertyOptional({ example: 'Manga', nullable: true })
  type: string | null;

  @ApiProperty({
    description: 'Recommandations venues de MangaUpdates',
    example: 72,
  })
  muVotes: number;

  @ApiProperty({
    description: 'Recommandations des utilisateurs Manga Tracker',
    example: 3,
  })
  appVotes: number;

  @ApiProperty({ description: 'muVotes + appVotes', example: 75 })
  totalVotes: number;

  @ApiProperty({
    description: "L'utilisateur connecté recommande-t-il cette œuvre ?",
  })
  recommendedByMe: boolean;

  @ApiProperty({
    description:
      'Suggérée par MangaUpdates (suggestion calculée, sans votes). ' +
      "S'affiche même à 0 vote ; les utilisateurs peuvent la recommander.",
  })
  muSuggested: boolean;
}

export class CommunityRecommendationsDto {
  @ApiProperty({ example: 55099564912 })
  sourceMuId: number;

  @ApiProperty({ type: [CommunityRecommendationItemDto] })
  items: CommunityRecommendationItemDto[];
}

/** Synthèse des notes d'une œuvre (`GET /mangas/:muId/ratings`). */
export class RatingSummaryDto {
  @ApiPropertyOptional({ description: 'Note MangaUpdates', nullable: true })
  mu_rating: number | null;

  @ApiPropertyOptional({
    description: 'Votants MangaUpdates (null si inconnu)',
    nullable: true,
  })
  mu_rating_votes: number | null;

  @ApiPropertyOptional({
    description: 'Moyenne des notes Manga Tracker',
    nullable: true,
  })
  community_rating: number | null;

  @ApiProperty({ description: 'Votants Manga Tracker' })
  community_rating_count: number;

  @ApiPropertyOptional({
    description: 'Note globale (MangaUpdates + Manga Tracker)',
    nullable: true,
  })
  aggregated_rating: number | null;

  @ApiProperty({ description: 'Total des votes derrière la note globale' })
  total_rating_votes: number;
}
