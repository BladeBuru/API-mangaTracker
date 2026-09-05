import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { normalizeMangaType } from '../manga-type';
import type { Manga } from '../manga.entity';
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

  @IsString()
  @IsOptional()
  @ApiPropertyOptional({
    description:
      'Type de publication MangaUpdates (Manga, Manhwa, Manhua, Novel, OEL…). ' +
      'Absent tant que le type est inconnu en base.',
  })
  type?: string;

  @IsOptional()
  @ApiPropertyOptional({
    description:
      'Genres MangaUpdates (Action, Romance…). Présent sur les sections de ' +
      "l'accueil (`/mangas/home/sections`) et la bibliothèque.",
    type: [String],
  })
  genres?: string[];

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

  @IsNumber()
  @IsOptional()
  @ApiPropertyOptional({
    description:
      "Total de chapitres signalé par l'utilisateur (« ce manga a plus de chapitres »). Présent uniquement si le report dépasse encore le total officiel ; totalChapters reflète déjà ce total effectif.",
  })
  userReportedTotalChapters?: number;

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
    const type = normalizeMangaType(data['record']['type']);
    if (type) dto.type = type;
    return dto;
  }

  /**
   * Carte construite depuis une ligne `manga` du catalogue local (sections
   * de l'accueil, listes servies sans appel MangaUpdates). Null-safe sur les
   * stubs : `year`/`rating` à `0` et covers à `''` tant que la ligne n'est
   * pas hydratée — même repli que les autres chemins DTO (l'app traduit `0`
   * en « absent »). `type` et `genres` ne sont exposés que s'ils sont connus.
   */
  static fromCatalog(manga: Manga): MangaQuickViewDto {
    const dto = new MangaQuickViewDto();
    dto.muId = Number(manga.mu_id);
    dto.title = manga.title;
    dto.year = manga.year ?? 0;
    dto.mediumCoverUrl = manga.medium_cover_url ?? '';
    dto.largeCoverUrl = manga.medium_cover_url ?? '';
    dto.rating =
      manga.rating !== null && manga.rating !== undefined
        ? Number(manga.rating)
        : 0;
    if (manga.type) dto.type = manga.type;
    if (Array.isArray(manga.genres) && manga.genres.length > 0) {
      dto.genres = manga.genres;
    }
    return dto;
  }

  /**
   * @param userReportedTotal Total « plus de chapitres » signalé par l'user
   *   (Chantier A). `totalChapters` expose le total EFFECTIF
   *   (max(officiel, report)) pour que le client débloque l'UI au-delà du
   *   total officiel sans logique supplémentaire.
   */
  static fromLibrary(userManga: UserManga, userReportedTotal?: number) {
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
    dto.totalChapters = Math.max(
      userManga.manga.total_chapters ?? 0,
      userReportedTotal ?? 0,
    );
    if (
      userReportedTotal !== undefined &&
      userReportedTotal > (userManga.manga.total_chapters ?? 0)
    ) {
      dto.userReportedTotalChapters = userReportedTotal;
    }
    dto.readingStatus = userManga.readingStatus;
    dto.associated = userManga.manga.associated ?? [];
    dto.customLink = userManga.custom_link ?? undefined;
    dto.userRating = userManga.user_rating ?? 0;
    if (userManga.manga.type) dto.type = userManga.manga.type;
    if (
      Array.isArray(userManga.manga.genres) &&
      userManga.manga.genres.length > 0
    ) {
      dto.genres = userManga.manga.genres;
    }
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
