import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
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
import { SearchMangaResponseDto } from './dto/search-manga-response.dto';
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

  /**
   * Upsert les recommandations MU en BDD pour un manga source.
   *
   * Côté `manga_recommendation` : insère les liens (source → recommandé,
   * weight). Côté `manga` : insère un *stub* (mu_id + title, autres champs
   * nullable) pour chaque manga recommandé absent — sans ça, ils seraient
   * filtrés silencieusement de `buildDtoFromScoreMap` (cf. migration
   * 1746230800000).
   *
   * `ON CONFLICT DO NOTHING` sur le stub : on n'écrase JAMAIS un manga
   * complet existant. Les détails complets sont remplis lazy par
   * `getMangaDetails` au premier clic user.
   */
  async saveRecommendations(
    sourceMuId: number,
    recos: {
      series_id: number;
      series_name: string;
      weight: number;
      small_cover_url?: string | null;
      medium_cover_url?: string | null;
    }[],
  ): Promise<void> {
    const sourceId = sourceMuId.toString();

    // 1. Stubs `manga` pour les recommandés absents — ON CONFLICT DO NOTHING
    //    pour ne jamais écraser un manga existant.
    //
    //    On pré-remplit les covers depuis `series_image` (nouveau format MU
    //    2026) quand elles sont disponibles : ça évite que la dialog
    //    "Mangas recommandés" reste sur des placeholders gris au premier
    //    affichage (perçu comme "Impossible de récupérer les recos"
    //    par les users). Le background refresh `getMangaDetails` complétera
    //    rating/year/total_chapters au premier clic sur le manga.
    if (recos.length > 0) {
      await this.mangaRepository
        .createQueryBuilder()
        .insert()
        .into(Manga)
        .values(
          recos.map((reco) => ({
            mu_id: reco.series_id.toString(),
            title: reco.series_name || `Manga ${reco.series_id}`,
            small_cover_url: reco.small_cover_url ?? null,
            medium_cover_url: reco.medium_cover_url ?? null,
            // total_chapters a un DEFAULT 0 ; rating/year restent nullable.
          })),
        )
        .orIgnore() // PG : ON CONFLICT (mu_id) DO NOTHING
        .execute();

      // Rétro-fix : si MU vient de fournir des covers pour des stubs déjà
      // créés sans cover (situation héritée du déploiement précédent qui ne
      // lisait pas `series_image`), on les complète sans toucher aux mangas
      // déjà détaillés (filtre `medium_cover_url IS NULL`).
      const recosAvecCover = recos.filter((r) => r.medium_cover_url);
      for (const reco of recosAvecCover) {
        await this.mangaRepository
          .createQueryBuilder()
          .update(Manga)
          .set({
            small_cover_url: reco.small_cover_url ?? null,
            medium_cover_url: reco.medium_cover_url ?? null,
          })
          .where('mu_id = :muId', { muId: reco.series_id.toString() })
          .andWhere('medium_cover_url IS NULL')
          .execute();
      }
    }

    // 2. Liens reco eux-mêmes
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
   * Agrégation **communautaire** des recommandations pour un manga
   * (2026-05-19). « Les utilisateurs qui ont ce manga ont aussi ces
   * autres mangas dans leur bibliothèque ». Complète les recos MU (qui
   * sont limitées à 5 max par leur API upstream).
   *
   * Renvoie jusqu'à 100 mangas avec leur compteur d'apparition (= nombre
   * de users distincts qui ont aussi le manga en biblio). Tri par count
   * décroissant.
   *
   * Note RGPD : on ne renvoie PAS les user_id, juste le compteur agrégé.
   */
  async findCommunityRecommendations(
    sourceMuId: number,
    limit = 100,
  ): Promise<{ recommended_mu_id: string; title: string; count: number }[]> {
    const rows = await this.userMangaRepository
      .createQueryBuilder('um2')
      .innerJoin(
        'user_manga',
        'um1',
        'um1.user_id = um2.user_id AND um1.manga_id = :sourceMuId',
        { sourceMuId: sourceMuId.toString() },
      )
      .innerJoin('um2.manga', 'm')
      .where('um2.manga_id != :sourceMuId', {
        sourceMuId: sourceMuId.toString(),
      })
      .select('um2.manga_id', 'recommended_mu_id')
      .addSelect('m.title', 'title')
      .addSelect('COUNT(DISTINCT um2.user_id)', 'count')
      .groupBy('um2.manga_id')
      .addGroupBy('m.title')
      .orderBy('count', 'DESC')
      .limit(limit)
      .getRawMany();

    return rows.map((r) => ({
      recommended_mu_id: r.recommended_mu_id as string,
      title: (r.title as string) ?? '',
      count: Number(r.count),
    }));
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
      // Format MU 2026-05 : voir commentaire détaillé dans
      // `MangaDetailsDto.fromMU` — flat `series_id` + `series_image.url.*`.
      // Le fallback nested reste là par sécurité.
      const rawRecos: any[] = data['recommendations'] ?? [];
      const recos = rawRecos
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
            small_cover_url: img?.thumb ?? null,
            medium_cover_url: img?.original ?? null,
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
   *
   * Background refresh : pour chaque reco avec une cover manquante (stub
   * minimal créé par saveRecommendations sans appel MU), déclenche un
   * fetch détail MU en arrière-plan (fire-and-forget) qui mettra à jour
   * la cover en BDD pour les prochaines lectures. Sans ça, l'app affiche
   * un placeholder vide ad vitam, et le widget RefreshableMangaImage ne
   * déclenche pas le refresh-cover (il ne le fait que sur 404, pas sur
   * URL vide).
   */
  async getRecommendationsAsQuickView(
    muId: number,
  ): Promise<MangaQuickViewDto[]> {
    // **2026-05-19** : agrège désormais MU recos (max 5 par manga, limite
    // upstream MU) + community recos (mangas que les autres users de la
    // communauté possèdent aussi en biblio). Avant on était limité aux 5
    // de MU → user veut "toutes les recos de la communauté".
    const recos = await this.getRecommendationsForManga(muId);
    const communityRecos = await this.findCommunityRecommendations(muId);

    // Merge : MU recos en premier (sorted by weight DESC déjà), puis
    // community recos par count DESC, dédupliqués sur mu_id. Tous deux
    // partagent le même format `recommended_mu_id` pour la suite.
    const seenIds = new Set<string>(recos.map((r) => r.recommended_mu_id));
    for (const c of communityRecos) {
      if (seenIds.has(c.recommended_mu_id)) continue;
      seenIds.add(c.recommended_mu_id);
      recos.push({
        // Note : `MangaRecommendation` entity requires id + dates etc.,
        // mais on n'ajoute jamais ces objets en BDD — ils sont juste shaped
        // identique pour le traitement aval. On utilise `as any` pour
        // contourner les champs requis sans risque (objet jamais persisté).
        source_mu_id: muId.toString(),
        recommended_mu_id: c.recommended_mu_id,
        recommended_title: c.title,
        weight: c.count, // sert juste pour le tri si on en a besoin
      } as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    }

    if (!recos.length) return [];

    const recMuIds = recos.map((r) => r.recommended_mu_id);
    const mangas = await this.mangaRepository
      .createQueryBuilder('m')
      .where('m.mu_id IN (:...ids)', { ids: recMuIds })
      .getMany();

    const mangaMap = new Map(mangas.map((m) => [m.mu_id, m]));

    // Background refresh fire-and-forget des stubs sans cover.
    // Limité à 5 mu_ids pour ne pas spammer MU sur chaque ouverture.
    const stubsSansCover = recos
      .filter((r) => {
        const m = mangaMap.get(r.recommended_mu_id);
        return !m || !m.medium_cover_url;
      })
      .slice(0, 5)
      .map((r) => Number(r.recommended_mu_id));

    if (stubsSansCover.length > 0) {
      this.logger.log(
        `Background refresh covers pour ${
          stubsSansCover.length
        } reco stubs : ${stubsSansCover.join(', ')}`,
      );
      // Pas de await — fire-and-forget, on n'attend pas la réponse MU.
      Promise.allSettled(
        stubsSansCover.map((id) =>
          this.getMangaDetails(id).catch((err) => {
            this.logger.warn(
              `Background refresh cover ${id} failed: ${err?.message ?? err}`,
            );
          }),
        ),
      ).catch(() => undefined);
    }

    return recos
      .map((reco) => {
        const manga = mangaMap.get(reco.recommended_mu_id);
        const dto = new MangaQuickViewDto();
        dto.muId = Number(reco.recommended_mu_id);
        dto.title = manga?.title ?? reco.recommended_title ?? '';
        dto.year = manga?.year ?? 0;
        // medium_cover_url = full size (image.url.original côté MU).
        dto.mediumCoverUrl = manga?.medium_cover_url ?? '';
        dto.largeCoverUrl = manga?.medium_cover_url ?? '';
        dto.rating = manga?.rating ? Number(manga.rating) : 0;
        return dto;
      })
      .filter((dto) => dto.title);
  }

  async searchManga(
    searchPattern: string,
    limit?: number,
    page?: number,
  ): Promise<SearchMangaResponseDto> {
    // Pertinence : on N'ENVOIE PAS d'orderby — le défaut MU (`score`) est le
    // classement par pertinence du site mangaupdates.com. Un orderby explicite
    // (rating/title) trie GLOBALEMENT les milliers de matches flous et éjecte
    // les titres de niche du top (vérifié 2026-07-03 : « Shadow System » et
    // « Naruto » sortent en #1 avec le défaut, disparaissent avec
    // orderby=rating). Pas de re-tri local non plus : il ne peut pas repêcher
    // un titre tronqué en amont et ne fait que casser l'ordre de MU.
    //   - stype: "title" → titres + titres alternatifs (hit_title).
    //   - perpage: max MU = 100 (au-delà, MU retombe silencieusement à 25).
    //   - page/perpage doivent être des entiers > 0 (MU 400 sinon,
    //     durci le 2026-05-17).
    const safeLimit = Math.min(Math.max(Math.trunc(limit ?? 20), 1), 100);
    const safePage = Math.max(Math.trunc(page ?? 1), 1);
    const payload: Record<string, unknown> = {
      search: searchPattern,
      stype: 'title',
      page: safePage,
      perpage: safeLimit,
      exclude_genre: NSFW_GENRES,
    };
    const { data } = await firstValueFrom(
      this.httpService.post(MU_TRENDS_URL, payload).pipe(
        catchError((error: AxiosError) => {
          // Logging détaillé pour diagnostiquer les MU API errors (400, 422…)
          // — sans ça on ne voyait que `ERR_BAD_REQUEST` opaque.
          this.logger.error(
            `MU search failed: code=${error.code} status=${error.response?.status} ` +
              `body=${JSON.stringify(error.response?.data)} ` +
              `payload=${JSON.stringify(payload)}`,
          );
          // MU 400 = paramètres rejetés (ex. page > 400) → 400 client,
          // pas un 500 : la requête est fautive, pas le service.
          if (error.response?.status === 400) {
            throw new BadRequestException(
              'Invalid search parameters for external service',
            );
          }
          throw `Impossible to retrieve mangas with search pattern ${searchPattern} from external service`;
        }),
      ),
    );

    const body = data as any;
    const results: any[] = body?.results ?? [];
    const totalHits = Number(body?.total_hits ?? results.length) || 0;

    // L'enveloppe est construite depuis l'ÉCHO de MU, pas les valeurs
    // demandées : MU coerce silencieusement perpage vers ses valeurs
    // acceptées (ex. 20 → 25, vérifié 2026-07-03). Baser hasMore sur la
    // demande désynchroniserait la pagination (pages vides en fin de liste).
    const effectivePerPage = Number(body?.per_page) || safeLimit;
    const effectivePage = Number(body?.page) || safePage;

    return {
      results: MangaQuickViewDto.arrayFromMu(results),
      totalHits,
      page: effectivePage,
      perPage: effectivePerPage,
      hasMore:
        results.length > 0 && effectivePage * effectivePerPage < totalHits,
    };
  }
}
