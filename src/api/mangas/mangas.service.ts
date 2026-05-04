import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MangaQuickViewDto } from './dto/manga-quick-view.dto';
import { catchError, firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { MU_DETAIL_URL, MU_TRENDS_URL, NSFW_GENRES } from './constants';
import { HelperService } from './helper.service';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { MangaRecommendation } from './manga-recommendation.entity';
import { UserManga } from './user-manga.entity';
import { Repository } from 'typeorm';
import { aggregateRating, CommunityRating } from './rating-aggregator';

/** Durée de vie du cache des recommandations : 7 jours en ms */
const RECO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class MangasService {
  constructor(
    private readonly httpService: HttpService,
    private readonly helperService: HelperService,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    @InjectRepository(MangaRecommendation)
    private readonly recoRepository: Repository<MangaRecommendation>,
    @InjectRepository(UserManga)
    private readonly userMangaRepository: Repository<UserManga>,
  ) {}

  /**
   * Calcule la note communautaire (moyenne des `user_rating` locaux > 0) et
   * la note agrégée Bayesian pour un ensemble de mangas.
   *
   * @param muIds Liste des `mu_id` (string ou number) à enrichir.
   * @param muRatingByMuId Map `mu_id` → note globale MU (sur 10).
   * @returns Map `mu_id` → {communityRating, count, aggregatedRating}.
   *
   * Retourne une map vide pour les mangas sans note locale ; le caller doit
   * gérer ce cas (typiquement → afficher uniquement la note MU).
   */
  async getCommunityRatings(
    muIds: string[],
    muRatingByMuId: Map<string, number>,
  ): Promise<Map<string, CommunityRating>> {
    if (muIds.length === 0) return new Map();

    const rows: Array<{ manga_id: string; avg: string; count: string }> =
      await this.userMangaRepository
        .createQueryBuilder('um')
        .select('um.manga_id::text', 'manga_id')
        .addSelect('AVG(um.user_rating)', 'avg')
        .addSelect('COUNT(*)', 'count')
        .where('um.user_rating > 0')
        .andWhere('um.manga_id IN (:...ids)', { ids: muIds })
        .groupBy('um.manga_id')
        .getRawMany();

    const localStats = new Map(
      rows.map((r) => [
        r.manga_id,
        { avg: parseFloat(r.avg), count: parseInt(r.count, 10) },
      ]),
    );

    const result = new Map<string, CommunityRating>();
    for (const muId of muIds) {
      const local = localStats.get(muId);
      const muRating = muRatingByMuId.get(muId) ?? 0;
      result.set(
        muId,
        aggregateRating(
          muRating,
          local ? local.avg : null,
          local ? local.count : 0,
        ),
      );
    }
    return result;
  }

  private readonly logger = new Logger(MangasService.name);

  async retrieveManga(
    filter: string,
    limit?: number,
    offset?: number,
  ): Promise<MangaQuickViewDto[]> {
    const url = this.helperService.formatRequestForMuApi(MU_TRENDS_URL, {
      limit: limit !== undefined ? limit.toString() : undefined,
      offset: offset !== undefined ? offset.toString() : undefined,
    });
    const payload = {
      orderby: filter,
      exclude_genre: NSFW_GENRES,
      perpage: limit,
      page: offset,
    };
    const { data } = await firstValueFrom(
      this.httpService.post<MangaQuickViewDto[]>(url, payload).pipe(
        catchError((error: AxiosError) => {
          this.logger.error(error.code);
          throw `Impossible to retrieve mangas with filter ${filter} from external service`;
        }),
      ),
    );

    return MangaQuickViewDto.arrayFromMu(data['results']);
  }

  async getMangaDetails(muId: number): Promise<MangaDetailsDto> {
    const url = MU_DETAIL_URL.concat(muId.toString());

    const { data } = await firstValueFrom(
      this.httpService.get<any>(url).pipe(
        catchError((error: AxiosError) => {
          this.logger.error(`${error.response.status}: ${error.response.data}`);
          if (error.response.status === 404) {
            throw new NotFoundException(
              `Manga with id ${muId} cannot be found`,
            );
          } else {
            throw new ServiceUnavailableException(
              'Impossible to retrieve manga details from external API. Service might be unavailable',
            );
          }
        }),
      ),
    );
    const details = MangaDetailsDto.fromMU(data);

    // Normalise les genres MU (forme `[{genre: "Action"}]` ou `["Action"]`)
    // avant stockage en BDD pour requêtage uniforme.
    const rawGenres = (details as any).genres ?? [];
    const normalizedGenres = Array.isArray(rawGenres)
      ? rawGenres
          .map((g: any) =>
            typeof g === 'string' ? g : g?.genre ?? g?.name ?? '',
          )
          .filter((g: string) => g.length > 0)
      : null;

    await this.mangaRepository.update(
      { mu_id: muId.toString() },
      {
        title: details.title,
        year: details.year,
        small_cover_url: details.smallCoverUrl,
        medium_cover_url: details.mediumCoverUrl,
        rating: details.rating,
        total_chapters: details.totalChapters,
        completed: details.completed,
        associated: details.associated,
        genres: normalizedGenres,
      },
    );

    // Sauvegarde des recommandations en arrière-plan (fire-and-forget)
    if (details.muRecommendations?.length) {
      this.saveRecommendations(muId, details.muRecommendations).catch((err) =>
        this.logger.warn(`Erreur sauvegarde recos pour manga ${muId}: ${err}`),
      );
    }

    return details;
  }

  async returnMangaIfExist(muId: string): Promise<Manga> {
    return await this.mangaRepository.findOneBy({
      mu_id: muId,
    });
  }

  /** Upsert les recommandations MU en BDD pour un manga source */
  async saveRecommendations(
    sourceMuId: number,
    recos: { series_id: number; series_name: string; weight: number }[],
  ): Promise<void> {
    const sourceId = sourceMuId.toString();
    for (const reco of recos) {
      await this.recoRepository
        .createQueryBuilder()
        .insert()
        .into(MangaRecommendation)
        .values({
          source_mu_id: sourceId,
          recommended_mu_id: reco.series_id.toString(),
          recommended_title: reco.series_name,
          weight: reco.weight,
        })
        .orUpdate(
          ['weight', 'recommended_title', 'updated_at'],
          ['source_mu_id', 'recommended_mu_id'],
        )
        .execute();
    }
  }

  /** Retourne les recommandations en cache pour un manga source */
  async getCachedRecommendations(
    sourceMuId: number,
  ): Promise<MangaRecommendation[]> {
    return this.recoRepository.find({
      where: { source_mu_id: sourceMuId.toString() },
      order: { weight: 'DESC' },
    });
  }

  /**
   * Récupère les recommandations depuis MangaUpdates pour un muId,
   * les sauvegarde et les retourne.
   * Utilisé quand le cache est absent ou périmé.
   */
  async fetchAndCacheRecommendations(
    muId: number,
  ): Promise<MangaRecommendation[]> {
    const url = MU_DETAIL_URL.concat(muId.toString());
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<any>(url).pipe(
          catchError((error: AxiosError) => {
            this.logger.warn(
              `Impossible de récupérer les recos pour manga ${muId}: ${error.message}`,
            );
            throw error;
          }),
        ),
      );
      // MU retourne : { series_id: { series_id: number, title: string }, weight: number }
      const rawRecos: any[] = data['recommendations'] ?? [];
      const recos = rawRecos
        .filter((r) => r.weight > 0 && (r.series_id?.series_id ?? r.series_id))
        .map((r) => {
          const isNested =
            typeof r.series_id === 'object' && r.series_id !== null;
          return {
            series_id: isNested
              ? Number(r.series_id.series_id)
              : Number(r.series_id),
            series_name: isNested
              ? r.series_id.title ?? r.series_id.series_name ?? ''
              : r.series_name ?? '',
            weight: Number(r.weight),
          };
        })
        .filter((r) => !isNaN(r.series_id) && r.series_id > 0);

      if (recos.length) {
        await this.saveRecommendations(muId, recos);
      }
      return this.getCachedRecommendations(muId);
    } catch {
      return [];
    }
  }

  /**
   * Retourne les recommandations pour un manga (depuis le cache ou MU si absent/périmé).
   */
  async getRecommendationsForManga(
    muId: number,
  ): Promise<MangaRecommendation[]> {
    const cached = await this.getCachedRecommendations(muId);
    if (cached.length === 0) {
      return this.fetchAndCacheRecommendations(muId);
    }
    // Rafraîchir si le cache est plus vieux que 7 jours (en background)
    const oldest = cached.reduce((prev, cur) =>
      prev.updated_at < cur.updated_at ? prev : cur,
    );
    if (Date.now() - oldest.updated_at.getTime() > RECO_CACHE_TTL_MS) {
      this.fetchAndCacheRecommendations(muId).catch(() => undefined);
    }
    return cached;
  }

  /**
   * Retourne les recommandations pour un manga sous forme de MangaQuickViewDto[],
   * enrichies avec les covers stockées en BDD.
   */
  async getRecommendationsAsQuickView(
    muId: number,
  ): Promise<MangaQuickViewDto[]> {
    const recos = await this.getRecommendationsForManga(muId);
    if (!recos.length) return [];

    const recMuIds = recos.map((r) => r.recommended_mu_id);
    const mangas = await this.mangaRepository
      .createQueryBuilder('m')
      .where('m.mu_id IN (:...ids)', { ids: recMuIds })
      .getMany();

    const mangaMap = new Map(mangas.map((m) => [m.mu_id, m]));

    return recos
      .map((reco) => {
        const manga = mangaMap.get(reco.recommended_mu_id);
        const dto = new MangaQuickViewDto();
        dto.muId = Number(reco.recommended_mu_id);
        dto.title = manga?.title ?? reco.recommended_title ?? '';
        dto.year = manga?.year ?? 0;
        dto.mediumCoverUrl = manga?.small_cover_url ?? '';
        dto.largeCoverUrl = manga?.medium_cover_url ?? '';
        dto.rating = manga?.rating ? Number(manga.rating) : 0;
        return dto;
      })
      .filter((dto) => dto.title);
  }

  async searchManga(searchPattern: string, limit: number, offset: number) {
    const payload = {
      search: searchPattern,
      perpage: limit,
      page: offset,
      exclude_genre: NSFW_GENRES,
    };
    const { data } = await firstValueFrom(
      this.httpService.post<MangaQuickViewDto[]>(MU_TRENDS_URL, payload).pipe(
        catchError((error: AxiosError) => {
          this.logger.error(error.code);
          throw `Impossible to retrieve mangas with search pattern ${searchPattern} from external service`;
        }),
      ),
    );

    return MangaQuickViewDto.arrayFromMu(data['results']);
  }
}
