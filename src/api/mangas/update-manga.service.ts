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

  /**
   * Taille de batch pour les fetches MU en background. MU rate-limite
   * agressivement au-delà de ~60 req/min — tirer 69 mangas en parallèle
   * en faisait planter ~85% silencieusement. 5 en parallèle + petite
   * pause entre batches reste sous le radar et finit en ~14 batches max.
   */
  private static readonly REFRESH_BATCH_SIZE = 5;

  /** Pause entre deux batches de refresh, pour étaler la charge MU. */
  private static readonly REFRESH_BATCH_DELAY_MS = 1000;

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
    // medium_cover_url stocke `image.url.original` (haute qualité) — pas la
    // vignette `small_cover_url` (thumb) qui rend flou sur mobile.
    dto.mediumCoverUrl = refreshed.medium_cover_url;
    dto.largeCoverUrl = refreshed.medium_cover_url;
    dto.rating = Number(refreshed.rating);
    dto.totalChapters = refreshed.total_chapters;
    dto.associated = refreshed.associated ?? [];
    return dto;
  }

  /**
   * Vérifie quels mangas de la liste ont des infos périmées (> 1 jour) et
   * lance leur rafraîchissement en arrière-plan. Les fetches MU sont
   * **batchés** (5 en parallèle, pause 1s entre batches) pour rester sous
   * le rate-limit MU. Le précédent `Promise.all` brut sur 69 mangas
   * faisait planter ~85% des fetches en silence.
   *
   * Retourne immédiatement la liste des mangas détectés comme outdated
   * (le caller n'attend pas la fin du refresh — c'est intentionnel).
   */
  async checkIfMangaArrayInfoIsOutdated(muIds: number[]): Promise<Manga[]> {
    // 1. Détection synchrone des mangas outdated (lecture DB rapide)
    const candidatesNullable = await Promise.all(
      muIds.map(async (muId) => {
        const entity = await this.mangasService.returnMangaIfExist(
          muId.toString(),
        );
        if (!entity || !this.isMangaInfoOutdated(entity)) return null;
        return entity;
      }),
    );
    const outdated = candidatesNullable.filter(
      (m): m is Manga => m !== null && m !== undefined,
    );

    if (outdated.length === 0) return [];

    // 2. Refresh en background, batché — fire-and-forget pour ne pas
    //    bloquer la response de la library.
    this.refreshOutdatedInBatches(outdated).catch((err) =>
      this.logger.warn(`Batched refresh fatal: ${err}`),
    );

    return outdated;
  }

  /**
   * @deprecated Conservé pour compat des call sites éventuels — préférer
   * `checkIfMangaArrayInfoIsOutdated` qui batche correctement.
   */
  async checkIfMangaInfoIsOutdated(muId: number): Promise<Manga | null> {
    const mangaEntity: Manga = await this.mangasService.returnMangaIfExist(
      muId.toString(),
    );

    if (!mangaEntity || !this.isMangaInfoOutdated(mangaEntity)) return null;

    this.updateMangaInfo(mangaEntity).catch((err) =>
      this.logger.warn(`Background update failed for manga ${muId}: ${err}`),
    );

    return mangaEntity;
  }

  /**
   * Rafraîchit les mangas outdated par batches séquentiels avec une pause
   * entre chaque batch. Trace les compteurs success/error pour visibilité.
   */
  private async refreshOutdatedInBatches(outdated: Manga[]): Promise<void> {
    const total = outdated.length;
    let success = 0;
    let failed = 0;

    for (
      let i = 0;
      i < outdated.length;
      i += UpdateMangaService.REFRESH_BATCH_SIZE
    ) {
      const batch = outdated.slice(
        i,
        i + UpdateMangaService.REFRESH_BATCH_SIZE,
      );
      const results = await Promise.allSettled(
        batch.map((manga) => this.updateMangaInfo(manga)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') success++;
        else failed++;
      }
      // Pause entre batches sauf le dernier
      if (i + UpdateMangaService.REFRESH_BATCH_SIZE < outdated.length) {
        await new Promise((r) =>
          setTimeout(r, UpdateMangaService.REFRESH_BATCH_DELAY_MS),
        );
      }
    }

    this.logger.log(
      `Background refresh terminé : ${success}/${total} OK, ${failed} échecs`,
    );
  }

  isMangaInfoOutdated(manga: Manga): boolean {
    return (
      DateHelper.deltaDays(manga.updated_at, new Date()) >
      this.DAYS_INFO_REFRESH_INTERVAL
    );
  }

  /**
   * Rafraîchit une ligne `manga` en relisant MangaUpdates.
   *
   * Implémentation : `getMangaDetails` fait déjà l'UPDATE en BDD avec un
   * surensemble des champs (title, year, small/medium_cover_url, rating,
   * total_chapters, completed, associated, genres). Inutile de faire un
   * deuxième UPDATE derrière (ce qui était fait avant ET non-awaited).
   *
   * Throw si MU est down — laissé propager pour que le caller
   * (`refreshOutdatedInBatches` via `Promise.allSettled`) compte l'échec.
   */
  async updateMangaInfo(manga: Manga): Promise<void> {
    this.logger.log(`Updating Info for Manga: ${manga.title}`);
    await this.mangasService.getMangaDetails(Number(manga.mu_id));
  }

  async getMangasIds(userMangas: UserManga[]): Promise<number[]> {
    const mangasIds: number[] = [];
    userMangas.forEach((userManga) => {
      mangasIds.push(parseInt(userManga.manga.mu_id));
    });
    return mangasIds;
  }
}
