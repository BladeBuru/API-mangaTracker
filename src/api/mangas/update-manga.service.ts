import { Injectable, Logger } from '@nestjs/common';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { MangasService } from './mangas.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { Repository } from 'typeorm';
import { DateHelper } from '@/common/helper/date.helper';

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
    const updatedMangas: Manga[] = [];
    muIds.forEach(async (muId) => {
      const updatedManga: Manga = await this.checkIfMangaInfoIsOutdated(muId);
      if (updatedManga !== null) updatedMangas.push(updatedManga);
    });
    return updatedMangas;
  }

  async checkIfMangaInfoIsOutdated(muId: number): Promise<Manga> {
    const mangaEntity = await this.mangasService.returnMangaIfExist(
      muId.toString(),
    );

    this.logger.debug(`Checking if info is outdated for ${mangaEntity}`);
    this.logger.debug(
      `Delta: ${DateHelper.deltaDays(mangaEntity.updated_at, new Date())}`,
    );

    if (!this.isMangaInfoOutdated(mangaEntity)) return;

    this.logger.debug(`Manga Info outdated ${mangaEntity}`);

    await this.updateMangaInfo(mangaEntity);

    return mangaEntity;
  }

  isMangaInfoOutdated(manga: Manga): boolean {
    return (
      DateHelper.deltaDays(manga.updated_at, new Date()) >
      this.DAYS_INFO_REFRESH_INTERVAL
    );
  }

  async updateMangaInfo(manga: Manga): Promise<void> {
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
}
