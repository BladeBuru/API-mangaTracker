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

  @ApiProperty()
  @IsString()
  type: string;

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
  categories?: { category: string; votes: number }[];

  @ApiPropertyOptional({
    description: 'List of associated names (other titles) for this manga',
  })
  @IsOptional()
  associated?: { title: string }[];

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

  @ApiPropertyOptional()
  category_recommendations?: { seriesId: number; weight: number }[];

  private static parseLatestChapter(status: string, fallback: number): number {
    if (!status) return fallback;
    const m = status.match(/(\d+)\+?\s*ch(?:ap(?:ter)?s?)?/i);
    return m ? Number(m[1]) : fallback;
  }

  private static parsePublicationStatus(status: string): string | null {
    if (!status) return null;
    const m = status.match(/\b(ongoing|complete|completed|hiatus)\b/i);
    if (!m) return null;
    const found = m[1].toLowerCase();
    return found === 'complete' ? 'completed' : found;
  }

  private static sanitizeLine(line: string): string {
    return (line ?? '')
      .replace(/<[^>]+>/g, '') // HTML
      .replace(/\*/g, '') // **bold**
      .replace(/[•·]/g, '') // puces
      .replace(/\u00A0/g, ' ') // NBSP
      .trim();
  }

  private static parseSeasonChapters(
    status: string,
  ): { season: string; chapters: number }[] {
    const result: { season: string; chapters: number }[] = [];
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
        } else if ((m = clean.match(/(\d+)\s*Hiatus\s*Specials?/i))) {
          label = 'Hiatus Specials';
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

  static fromMU(mu: any): MangaDetailsDto {
    const s = String(mu.status ?? '');
    const seasonChapters = this.parseSeasonChapters(s);
    const bonusChapters = this.parseBonusChapters(s);
    const publication = this.parsePublicationStatus(s);

    const dto = new MangaDetailsDto();
    const rawCats = Array.isArray(mu.categories) ? mu.categories : [];
    dto.categories = rawCats
      .map((c: any) => ({
        category: String(c?.category ?? '').trim(),
        votes: Number(c?.votes ?? 0),
      }))
      .filter((c: { category: string | any[] }) => c.category.length > 0);
    const rawRecs = Array.isArray(mu.category_recommendations)
      ? mu.category_recommendations
      : [];
    dto.category_recommendations = rawRecs
      .map((r: any) => ({
        seriesId: Number(r?.series_id ?? 0),
        weight: Number(r?.weight ?? 0),
      }))
      .filter((r: { seriesId: number }) => r.seriesId > 0);
    dto.muId = mu.series_id;
    dto.title = mu.title;
    dto.type = mu.type;
    dto.description = mu.description ?? '';
    dto.status = mu.status ?? null;
    dto.publicationStatus = publication ?? undefined;
    dto.year = mu.year ?? 0;
    dto.smallCoverUrl = mu.image?.url?.thumb ?? '';
    dto.mediumCoverUrl = mu.image?.url?.original ?? '';
    dto.rating = Number(mu.bayesian_rating ?? 0);
    dto.totalChapters = this.parseLatestChapter(
      mu.status ?? '',
      mu.latest_chapter ?? 0,
    );
    dto.seasonChapters = seasonChapters;
    dto.bonusChapters = bonusChapters;
    dto.completed = Boolean(mu.completed);
    dto.authors = mu.authors ?? [];
    dto.genres = mu.genres ?? [];
    dto.associated = mu.associated ?? [];
    dto.anime = mu.anime ?? [];
    return dto;
  }
}
