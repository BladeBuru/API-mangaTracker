import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional } from 'class-validator';
import { UserManga } from '../user-manga.entity';

export class MangaQuickViewDto {
  @ApiProperty()
  muId: number;

  @ApiProperty()
  title: string;

  @ApiProperty()
  year: number;

  @ApiProperty()
  mediumCoverUrl: string;

  @ApiProperty()
  largeCoverUrl: string;

  @ApiProperty()
  rating: number;

  @IsNumber()
  @IsOptional()
  @ApiPropertyOptional()
  readChapters: number;

  @IsNumber()
  @IsOptional()
  @ApiPropertyOptional()
  totalChapters: number;

  @IsOptional()
  @ApiPropertyOptional()
  public readingStatus: string;

  @IsOptional()
  @ApiPropertyOptional({
    description: 'Liste des noms associés (autres titres) pour ce manga',
  })
  associated?: { title: string }[];

  @IsOptional()
  @ApiPropertyOptional({
    description: "Lien personnalisé de l'utilisateur pour ce manga",
  })
  customLink?: string;

  @IsNumber()
  @IsOptional()
  @ApiPropertyOptional({
    description: "Note donnée par l'utilisateur (0 = pas de note, 1-10)",
  })
  userRating?: number;

  @IsOptional()
  @ApiPropertyOptional({
    description:
      'Titres des mangas de la bibliothèque qui ont conduit à cette recommandation (top 3 contributeurs au score). Présent uniquement dans les réponses de /recommendations.',
    type: [String],
  })
  recommendedBecauseOf?: string[];

  @IsNumber()
  @IsOptional()
  @ApiPropertyOptional({
    description:
      "Moyenne des notes données par les utilisateurs de Manga Tracker (1-10). Null si personne n'a noté ce manga localement.",
  })
  communityRating?: number;

  @IsNumber()
  @IsOptional()
  @ApiPropertyOptional({
    description:
      "Nombre d'utilisateurs Manga Tracker ayant noté ce manga (rating > 0).",
  })
  communityRatingCount?: number;

  @IsNumber()
  @IsOptional()
  @ApiPropertyOptional({
    description:
      'Note agrégée Bayesian combinant la note globale MangaUpdates (rating) et la note communautaire locale (communityRating), pondérée par le nombre de votants. Plus stable pour les mangas peu notés.',
  })
  aggregatedRating?: number;

  static fromMu(data: any) {
    const dto = new MangaQuickViewDto();
    dto.muId = data['record']['series_id'];
    dto.title = data['record']['title'];
    dto.year = data['record']['year'];
    // mediumCoverUrl = image principale haute qualité (servie au client par défaut).
    // largeCoverUrl = même URL pour compat (les clients utilisaient large pour
    // les zooms cover plein écran). On évite la `thumb` qui rend flou sur tel.
    dto.mediumCoverUrl = data['record']['image']['url']['original'];
    dto.largeCoverUrl = data['record']['image']['url']['original'];
    dto.rating = data['record']['bayesian_rating'];
    dto.associated = data['record']['associated'] ?? [];
    return dto;
  }

  static fromLibrary(userManga: UserManga) {
    const dto = new MangaQuickViewDto();
    dto.muId = parseInt(userManga.manga.mu_id);
    dto.title = userManga.manga.title;
    dto.year = userManga.manga.year;
    // medium_cover_url stocke `image.url.original` (full size) — c'est ce
    // qu'on veut servir comme image principale (la `small`/`thumb` rend flou).
    dto.mediumCoverUrl = userManga.manga.medium_cover_url;
    dto.largeCoverUrl = userManga.manga.medium_cover_url;
    dto.rating = userManga.manga.rating;
    dto.readChapters = userManga.user_read_chapters;
    dto.totalChapters = userManga.manga.total_chapters;
    dto.readingStatus = userManga.readingStatus;
    dto.associated = userManga.manga.associated ?? [];
    dto.customLink = userManga.custom_link ?? undefined;
    dto.userRating = userManga.user_rating ?? 0;
    return dto;
  }

  static arrayFromMu(array: any): MangaQuickViewDto[] {
    const mangas: MangaQuickViewDto[] = new Array(array.length);
    for (let i = 0; i < array.length; i++) {
      mangas[i] = MangaQuickViewDto.fromMu(array[i]);
    }
    return mangas;
  }
}
