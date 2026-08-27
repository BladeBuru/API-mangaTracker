import { plainToClass, classToPlain } from 'class-transformer';
import { Manga } from '../manga.entity';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class MangaDetailsDto {
  @ApiProperty()
  @IsNumber()
  muId: number;

  @ApiProperty()
  @IsString()
  title: string;

  @ApiProperty()
  @IsString()
  description: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  status: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  publicationStatus?: string;

  @ApiProperty()
  @IsNumber()
  year: number;

  @ApiProperty()
  @IsString()
  smallCoverUrl: string;

  @ApiProperty()
  @IsString()
  mediumCoverUrl: string;

  @ApiProperty()
  @IsNumber()
  rating: number;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  readChapters: number;

  @ApiProperty()
  @IsNumber()
  totalChapters: number;

  @ApiPropertyOptional()
  @IsOptional()
  seasonChapters?: { season: string; chapters: number }[];

  @ApiPropertyOptional()
  @IsOptional()
  bonusChapters?: { season: string; chapters: number }[];

  @ApiProperty()
  @IsBoolean()
  completed: boolean;

  @ApiPropertyOptional()
  authors: any[];

  @ApiPropertyOptional()
  genres: any[];

  @ApiPropertyOptional()
  anime: any[];

  @ApiPropertyOptional()
  categories: any[];

  @ApiPropertyOptional({
    description: 'List of associated names (other titles) for this manga',
  })
  @IsOptional()
  associated?: { title: string }[];

  @ApiPropertyOptional({
    description:
      'Recommandations MangaUpdates (séries similaires avec poids 1-100). ' +
      'Inclut les URLs de cover (small/medium) quand MU les fournit dans ' +
      "`series_image`, ce qui permet d'éviter une cover vide sur la fiche " +
      "détail des recos tant que le manga recommandé n'a pas été ouvert.",
  })
  @IsOptional()
  muRecommendations?: {
    series_id: number;
    series_name: string;
    weight: number;
    small_cover_url?: string | null;
    medium_cover_url?: string | null;
  }[];

  @ApiPropertyOptional({ description: 'Custom user link for this manga' })
  @IsOptional()
  @IsString()
  custom_link?: string;

  @ApiPropertyOptional({
    description:
      "Indique si le manga est dans la bibliothèque de l'utilisateur",
  })
  @IsOptional()
  @IsBoolean()
  in_library?: boolean;

  @ApiPropertyOptional({
    description: "Nombre de chapitres lus par l'utilisateur",
  })
  @IsOptional()
  @IsNumber()
  read_chapters_count?: number;

  @ApiPropertyOptional({
    description: "Note de l'utilisateur connecté (0 = pas de note, 1-10)",
  })
  @IsOptional()
  @IsNumber()
  user_rating?: number;

  @ApiPropertyOptional({
    description:
      'Moyenne des notes des utilisateurs Manga Tracker pour ce manga',
  })
  @IsOptional()
  @IsNumber()
  community_rating?: number;

  @ApiPropertyOptional({
    description: "Nombre d'utilisateurs Manga Tracker ayant noté ce manga",
  })
  @IsOptional()
  @IsNumber()
  community_rating_count?: number;

  @ApiPropertyOptional({
    description:
      'Note agrégée Bayesian (note MU + notes communautaires locales)',
  })
  @IsOptional()
  @IsNumber()
  aggregated_rating?: number;

  @ApiPropertyOptional({
    description:
      'Description traduite dans la langue du header Accept-Language. ' +
      'Absent si la langue est en/absente/non supportée ou si la ' +
      'traduction a échoué — `description` reste TOUJOURS l’original ' +
      'anglais (champ additif, non-breaking).',
  })
  @IsOptional()
  @IsString()
  translated_description?: string;

  private static parseLatestChapter(status: string, fallback: number): number {
    if (!status) return fallback;
    const match = status.match(/(\d+)\s*Chapters/);
    return match ? +match[1] : fallback;
  }

  private static sanitizeLine(line: string): string {
    // retire les marqueurs Markdown bold et trim
    return line.replace(/\*/g, '').trim();
  }

  private static parsePublicationStatus(status: string): string | null {
    if (!status) return null;
    const firstLine = status ? status.split(/\r?\n/)[0] : '';
    const m = firstLine.match(/\(\s*([^)]+?)\s*\)/);
    return m ? m[1].trim() : null;
  }

  private static parseSeasonChapters(
    status: string,
  ): { season: string; chapters: number }[] {
    const result: { season: string; chapters: number }[] = [];
    if (!status) return result;
    for (const rawLine of status.split(/\r?\n/)) {
      const line = this.sanitizeLine(rawLine);
      // capture "S1:", "S2 Part 1:", "S2 Part 2:", etc.
      const match = line.match(
        /^(S\d+(?:\s+Part\s+\d+)?):.*?(\d+)(?=\+?\s*Chapters)/i,
      );
      if (match) {
        result.push({
          season: match[1],
          chapters: Number(match[2]),
        });
      }
    }
    return result;
  }

  private static parseBonusChapters(
    status: string,
  ): { season: string; chapters: number }[] {
    const result: { season: string; chapters: number }[] = [];
    if (!status) return result;
    const seen = new Set<string>();
    const lines = status.split(/\r?\n/).map((l) => this.sanitizeLine(l));

    // 1) Extras de la ligne globale (ex : "131 Chapters + 7 Bonus Chapters + …")
    const headerLine = lines.find((l) => /^\d+\s*Chapters/i.test(l));
    if (headerLine) {
      const extras = headerLine
        .replace(/^\d+\s*Chapters/, '')
        .split('+')
        .map((p) => p.trim())
        .filter(Boolean);

      for (const extra of extras) {
        const clean = extra.replace(/\(.*?\)/g, '').trim();
        if (!clean) continue;

        let label: string | null = null;
        let chapters = 1;
        let m: RegExpMatchArray | null;

        if ((m = clean.match(/(\d+)\s*Bonus/i))) {
          label = 'Bonus';
          chapters = Number(m[1]);
        } else if ((m = clean.match(/(\d+)\s*Epilogue/i))) {
          label = 'Epilogue';
          chapters = Number(m[1]);
        } else if ((m = clean.match(/(\d+)\s*Prologue/i))) {
          label = 'Prologue';
          chapters = Number(m[1]);
        } else if ((m = clean.match(/(\d+)\s*Short Stories?/i))) {
          label = 'Short Stories';
          chapters = Number(m[1]);
        } else if ((m = clean.match(/(\d+)\s*Afterwords?/i))) {
          label = 'Afterwords';
          chapters = Number(m[1]);
        } else if (/New Series Announcement/i.test(clean)) {
          label = 'New Series Announcement';
          chapters = 1;
        } else if ((m = clean.match(/(\d+)\s*Special/i))) {
          label = 'Special';
          chapters = Number(m[1]);
        }

        if (label && !seen.has(label)) {
          seen.add(label);
          result.push({ season: label, chapters });
        }
      }
    }

    // 2) Parcours des lignes de saisons et bonus annexes
    for (const line of lines.slice(1)) {
      // Side Story
      const sideMatch = line.match(/^Side Story\s*:\s*(\d+)(?=\s*Chapters)/i);
      if (sideMatch && !seen.has('Side Story')) {
        seen.add('Side Story');
        result.push({ season: 'Side Story', chapters: Number(sideMatch[1]) });
        continue;
      }

      // Recap
      const recapMatch = line.match(/^(S\d+-S\d+\s*Recap)/i);
      if (recapMatch && !seen.has(recapMatch[1])) {
        seen.add(recapMatch[1]);
        result.push({ season: recapMatch[1], chapters: 1 });
        continue;
      }

      // Lignes de saisons ("S1:", "S2 Part 1:", etc.)
      if (!/^(?:S\d+(?:\s+Part\s+\d+)?)\s*:/i.test(line)) {
        continue;
      }

      const extras = line
        .slice(line.indexOf(':') + 1)
        .split('+')
        .map((p) => p.trim());

      for (const extra of extras) {
        let label: string | null = null;
        let chapters = 1;
        let m: RegExpMatchArray | null;

        if ((m = extra.match(/(\d+)\s*Bonus/i))) {
          label = 'Bonus';
          chapters = Number(m[1]);
        } else if (/Epilogue/i.test(extra)) {
          label = 'Epilogue';
          chapters = 1;
        } else if (/Prologue\b/i.test(extra)) {
          label = 'Prologue';
          chapters = 1;
        } else if (/Afterwords?/i.test(extra)) {
          label = 'Afterwords';
          chapters = 1;
        } else if (/New Series Announcement/i.test(extra)) {
          label = 'New Series Announcement';
          chapters = 1;
        } else if ((m = extra.match(/(\d+)\s*Short Stories?/i))) {
          label = 'Short Stories';
          chapters = Number(m[1]);
        } else if ((m = extra.match(/(\d+)\s*Special/i))) {
          label = 'Special';
          chapters = Number(m[1]);
        }

        if (label && !seen.has(label)) {
          seen.add(label);
          result.push({ season: label, chapters });
        }
      }
    }

    return result;
  }

  static toModel(mangaDetailsDto: MangaDetailsDto): Manga {
    const data = classToPlain(mangaDetailsDto);
    return plainToClass(Manga, data);
  }

  static fromMU(muObject: any): MangaDetailsDto {
    const seasonChapters = this.parseSeasonChapters(muObject.status);
    const bonusChapters = this.parseBonusChapters(muObject.status);
    const readingStatus = this.parsePublicationStatus(muObject.status);

    const mangaDetailsDto = new MangaDetailsDto();
    mangaDetailsDto.title = muObject['title'];
    mangaDetailsDto.description = muObject['description'];
    mangaDetailsDto.status = muObject['status'];
    mangaDetailsDto.publicationStatus = readingStatus;
    // ⚠️ Les propriétés du DTO sont en camelCase (cf. déclarations ci-dessus).
    // Les consumers (mangas.service.ts, sync-manga.service.ts) lisent
    // `details.smallCoverUrl` / `details.mediumCoverUrl` / `details.totalChapters`.
    // Assigner en snake_case ici (bracket notation) laissait les propriétés
    // camelCase à `undefined`, ce qui faisait que `mangaRepository.update()`
    // ne touchait pas les colonnes `*_cover_url` et `total_chapters` côté DB
    // → cover NULL ad vitam → endpoint `/mangas/:muId/cover` répondait 404
    // "No cover URL after refresh".
    mangaDetailsDto.smallCoverUrl = muObject['image']['url']['thumb'];
    mangaDetailsDto.mediumCoverUrl = muObject['image']['url']['original'];
    mangaDetailsDto.year = muObject['year'];
    mangaDetailsDto.rating = muObject['bayesian_rating'];
    mangaDetailsDto.totalChapters = MangaDetailsDto.parseLatestChapter(
      muObject.status,
      muObject.latest_chapter,
    );
    mangaDetailsDto.seasonChapters = seasonChapters.map(
      ({ season, chapters }) => ({ season, chapters }),
    );
    mangaDetailsDto.bonusChapters = bonusChapters.map(
      ({ season, chapters }) => ({ season, chapters }),
    );
    mangaDetailsDto.completed = muObject['completed'];
    mangaDetailsDto.muId = muObject['series_id'];
    mangaDetailsDto.authors = muObject['authors'];
    mangaDetailsDto.genres = muObject['genres'];
    mangaDetailsDto.associated = muObject['associated'] ?? [];

    // Recommandations communautaires MangaUpdates.
    //
    // Format MU observé en 2026-05-18 (validé via curl) :
    //   {
    //     series_name: string,
    //     series_url: string,
    //     series_id: number,              <-- plat (plus { series_id, title })
    //     series_image: {
    //       url: { original: string, thumb: string },
    //       height, width
    //     },
    //     weight: number                  <-- 0-100 maintenant
    //   }
    //
    // Le fallback `isNested` ci-dessous reste là par sécurité au cas où MU
    // re-publie l'ancien format sur certaines séries — coût minime, évite
    // une régression silencieuse.
    const rawRecos: any[] = muObject['recommendations'] ?? [];
    mangaDetailsDto.muRecommendations = rawRecos
      .filter((r) => r.weight > 0 && (r.series_id?.series_id ?? r.series_id))
      .map((r) => {
        const isNested =
          typeof r.series_id === 'object' && r.series_id !== null;
        const img = r.series_image?.url ?? r.series_id?.image?.url ?? null;
        return {
          series_id: isNested
            ? Number(r.series_id.series_id)
            : Number(r.series_id),
          series_name: isNested
            ? r.series_id.title ?? r.series_id.series_name ?? ''
            : r.series_name ?? '',
          weight: Number(r.weight),
          // Pre-cache des covers : si MU les fournit on les stocke avec le
          // stub, sinon `null` et le background refresh ira chercher le
          // détail complet. Évite l'aspect "vide" perçu comme un bug par le
          // user à la première ouverture.
          small_cover_url: img?.thumb ?? null,
          medium_cover_url: img?.original ?? null,
        };
      })
      .filter((r) => !isNaN(r.series_id) && r.series_id > 0);

    return mangaDetailsDto;
  }
}
