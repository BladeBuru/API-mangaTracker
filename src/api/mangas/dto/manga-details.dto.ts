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

  @ApiPropertyOptional({ description: 'Custom user link for this manga' })
  @IsOptional()
  @IsString()
  custom_link?: string;

  @ApiPropertyOptional({
    description: "Indicates if the manga is in the user's library",
  })
  @IsOptional()
  @IsBoolean()
  in_library?: boolean;

  @ApiPropertyOptional({
    description: 'Number of chapters read by the user',
  })
  @IsOptional()
  @IsNumber()
  read_chapters_count?: number;

  private static parseLatestChapter(status: string, fallback: number): number {
    if (!status) return fallback;
    const match = status.match(/(\d+)\s*Chapters/);
    return match ? +match[1] : fallback;
  }

  private static sanitizeLine(line: string): string {
    // remove bold and trim Markdown markers
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

    // 1) Extract the global line (eg: "131 Chapters + 7 Bonus Chapters + ...")
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

    // 2) Seasons and bonuses
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

      // Season lines ("S1:", "S2 Part 1:", etc.)
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
    mangaDetailsDto['title'] = muObject['title'];
    mangaDetailsDto['description'] = muObject['description'];
    mangaDetailsDto['status'] = muObject['status'];
    mangaDetailsDto.publicationStatus = readingStatus;
    mangaDetailsDto['small_cover_url'] = muObject['image']['url']['thumb'];
    mangaDetailsDto['medium_cover_url'] = muObject['image']['url']['original'];
    mangaDetailsDto['year'] = muObject['year'];
    mangaDetailsDto['rating'] = muObject['bayesian_rating'];
    mangaDetailsDto['total_chapters'] = MangaDetailsDto.parseLatestChapter(
      muObject.status,
      muObject.latest_chapter,
    );
    mangaDetailsDto.seasonChapters = seasonChapters.map(
      ({ season, chapters }) => ({ season, chapters }),
    );
    mangaDetailsDto.bonusChapters = bonusChapters.map(
      ({ season, chapters }) => ({ season, chapters }),
    );
    mangaDetailsDto['total_chapters'] = MangaDetailsDto.parseLatestChapter(
      muObject.status,
      muObject.latest_chapter,
    );
    mangaDetailsDto.seasonChapters = seasonChapters.map(
      ({ season, chapters }) => ({ season, chapters }),
    );
    mangaDetailsDto.bonusChapters = bonusChapters.map(
      ({ season, chapters }) => ({ season, chapters }),
    );
    mangaDetailsDto['completed'] = muObject['completed'];
    mangaDetailsDto['mu_id'] = muObject['series_id'];
    mangaDetailsDto['authors'] = muObject['authors'];
    mangaDetailsDto['genres'] = muObject['genres'];
    mangaDetailsDto['associated'] = muObject['associated'] ?? [];
    return mangaDetailsDto;
  }
}
