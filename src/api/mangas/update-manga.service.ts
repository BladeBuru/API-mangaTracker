import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MangasService } from './mangas.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { Repository } from 'typeorm';
import { DateHelper } from '@/common/helper/date.helper';
import { UserManga } from './user-manga.entity';
import { MangaQuickViewDto } from './dto/manga-quick-view.dto';

@Injectable()
export class UpdateMangaService {
  DAYS_INFO_REFRESH_INTERVAL = 1;

  constructor(
    private readonly mangasService: MangasService,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
  ) {}
  private readonly logger = new Logger(UpdateMangaService.name);

  /**
   * Force le rafraîchissement des URLs de couverture d'un manga depuis
   * MangaUpdates. Utile lorsqu'un client détecte une cover cassée (les URLs
   * MU expirent périodiquement).
   *
   * Refetch via {@link MangasService.getMangaDetails} qui :
   *   1. Appelle l'API MangaUpdates,
   *   2. Met à jour `small_cover_url` / `medium_cover_url` (et autres champs)
   *      en BDD,
   *   3. Sauvegarde les recommandations en arrière-plan.
   *
   * @throws {NotFoundException} si le manga n'existe pas en base.
   */
  async refreshCovers(muId: number): Promise<MangaQuickViewDto> {
    const existing = await this.mangaRepository.findOneBy({
      mu_id: muId.toString(),
    });
    if (!existing) {
      throw new NotFoundException(`Manga with mu_id ${muId} not found`);
    }

    // getMangaDetails fait l'appel MU + UPDATE en BDD des URLs covers.
    // Si l'API MU est indispo, getMangaDetails throw une exception qui
    // remontera proprement au controller (404 ou 503).
    await this.mangasService.getMangaDetails(muId);

    const refreshed = await this.mangaRepository.findOneBy({
      mu_id: muId.toString(),
    });
    if (!refreshed) {
      // Théoriquement impossible — le manga existait juste avant l'update.
      throw new NotFoundException(
        `Manga with mu_id ${muId} disappeared during refresh`,
      );
    }

    const dto = new MangaQuickViewDto();
    dto.muId = Number(refreshed.mu_id);
    dto.title = refreshed.title;
    dto.year = refreshed.year;
    dto.mediumCoverUrl = refreshed.small_cover_url;
    dto.largeCoverUrl = refreshed.medium_cover_url;
    dto.rating = Number(refreshed.rating);
    dto.totalChapters = refreshed.total_chapters;
    dto.associated = refreshed.associated ?? [];
    return dto;
  }

  async checkIfMangaArrayInfoIsOutdated(muIds: number[]): Promise<Manga[]> {
    const results = await Promise.all(
      muIds.map((muId) => this.checkIfMangaInfoIsOutdated(Number(muId))),
    );
    return results.filter(
      (manga): manga is Manga => manga !== null && manga !== undefined,
    );
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
