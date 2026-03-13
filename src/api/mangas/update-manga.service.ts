import { Injectable, Logger } from '@nestjs/common';
import { MangasService } from './mangas.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { Repository } from 'typeorm';
import { DateHelper } from '@/common/helper/date.helper';
import { UserManga } from './user-manga.entity';

@Injectable()
export class UpdateMangaService {
  DAYS_INFO_REFRESH_INTERVAL = 1;

  constructor(
    private readonly mangasService: MangasService,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
  ) {}
  private readonly logger = new Logger(UpdateMangaService.name);

  async checkIfMangaArrayInfoIsOutdated(muIds: number[]): Promise<Manga[]> {
    const results = await Promise.all(
      muIds.map((muId) => this.checkIfMangaInfoIsOutdated(Number(muId))),
    );
    return results.filter((manga): manga is Manga => manga !== null && manga !== undefined);
  }

  async checkIfMangaInfoIsOutdated(muId: number): Promise<Manga | null> {
    const mangaEntity: Manga = await this.mangasService.returnMangaIfExist(
      muId.toString(),
    );

    if (!this.isMangaInfoOutdated(mangaEntity)) return null;

    this.updateMangaInfo(mangaEntity).catch((err) =>
      this.logger.warn(`Background update failed for manga ${muId}: ${err}`),
    );

    return mangaEntity;
  }

  isMangaInfoOutdated(manga: Manga): boolean {
    return (
      DateHelper.deltaDays(manga.updated_at, new Date()) >
      this.DAYS_INFO_REFRESH_INTERVAL
    );
  }

  async updateMangaInfo(manga: Manga): Promise<void> {
    this.logger.log(`Updating Info for Manga: ${manga.title}`);
    const freshMangaDto = await this.mangasService.getMangaDetails(
      Number(manga.mu_id),
    );
    this.mangaRepository.update(
      { mu_id: manga.mu_id },
      {
        title: freshMangaDto.title,
        small_cover_url: freshMangaDto.smallCoverUrl,
        medium_cover_url: freshMangaDto.mediumCoverUrl,
        total_chapters: freshMangaDto.totalChapters,
        rating: freshMangaDto.rating,
        year: freshMangaDto.year,
      },
    );
  }

  async getMangasIds(userMangas: UserManga[]): Promise<number[]> {
    const mangasIds: number[] = [];
    userMangas.forEach((userManga) => {
      mangasIds.push(parseInt(userManga.manga.mu_id));
    });
    return mangasIds;
  }
}
