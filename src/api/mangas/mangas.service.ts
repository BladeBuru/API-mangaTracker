import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MangaQuickViewDto } from './dto/manga-quick-view.dto';
import { DismissalService } from '@/api/recommendations/dismissal.service';
import { ReadingStatusAutoUpdateService } from '@/api/library/reading-status-auto-update.service';
import { catchError, firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { MU_DETAIL_URL, MU_TRENDS_URL, NSFW_GENRES } from './constants';
import { normalizeGenres } from './genre.utils';
import { MuRateLimitException } from './exceptions/mu-rate-limit.exception';
import { HelperService } from './helper.service';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { SearchMangaResponseDto } from './dto/search-manga-response.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { MangaRecommendation } from './manga-recommendation.entity';
import { UserManga } from './user-manga.entity';
import { Repository } from 'typeorm';
import { aggregateRating, CommunityRating } from './rating-aggregator';
import {
  buildAssociatedUpdate,
  buildProtectedColumnsUpdate,
} from './manga-completeness.util';
import { RecoGraphIngestService } from './reco-graph-ingest.service';
import { RecoLinkKind } from './reco-graph.mapper';

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
    private readonly dismissals: DismissalService,
    private readonly readingStatusAutoUpdate: ReadingStatusAutoUpdateService,
    private readonly recoGraph: RecoGraphIngestService,
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
    // avant stockage en BDD pour requêtage uniforme (helper partagé).
    const normalizedGenres = normalizeGenres((details as any).genres);
    const newTotal = Number(details.totalChapters) || 0;

    // Total AVANT écriture : seule une hausse effective doit basculer les
    // lecteurs « à jour » en « en cours » (cf. ReadingStatusAutoUpdateService).
    // Une fiche inconnue en base n'a aucune entrée bibliothèque (FK) → rien à
    // basculer. Lecture indexée (mu_id unique), négligeable devant l'appel MU.
    const previousTotal = await this.readCurrentTotal(muId);

    // A-5 : GREATEST inconditionnel sur total_chapters — un refresh MU ne
    // fait JAMAIS régresser le total (regex status MU peu fiable, un user à
    // 90 chapitres lus prouve total ≥ 90 — cf. decisions.md).
    //
    // 2026-08-28 (complétude des données) : `year`, `rating`, les covers et
    // `genres` passent par `buildProtectedColumnsUpdate` — ces colonnes ne
    // sont plus dans le `SET` quand MU ne fournit pas de valeur. L'UPDATE
    // était inconditionnel : un titre peu voté (`bayesian_rating: null`) ou
    // sans année remettait à NULL une valeur correctement remplie par la
    // synchro nocturne, et la carte reperdait son année/ses étoiles. Même
    // doctrine que l'upsert catalogue (cf. `catalog-sync.mapper.ts`). Une
    // vraie valeur MU écrase toujours normalement l'ancienne.
    // `title` / `completed` restent écrasés (overwrite). `associated` passe
    // désormais par `buildAssociatedUpdate` (2026-08-29) : le DTO le remplit
    // avec `[]` quand MU ne renvoie rien, et cet UPDATE inconditionnel
    // pouvait donc EFFACER des titres alternatifs déjà en base.
    await this.mangaRepository
      .createQueryBuilder()
      .update(Manga)
      .set({
        title: details.title,
        total_chapters: () => 'GREATEST(total_chapters, :newTotal)',
        completed: details.completed,
        ...buildAssociatedUpdate(details.associated),
        ...buildProtectedColumnsUpdate(details, normalizedGenres),
      })
      .setParameter('newTotal', newTotal)
      .where('mu_id = :muId', { muId: muId.toString() })
      .execute();

    // Nouveaux chapitres côté MU → « à jour » n'est plus vrai pour ceux qui
    // n'ont pas lu jusqu'au nouveau total. Couvre aussi `checkManga` (refresh
    // 6h), `UpdateMangaService` et `MangaSyncService`, qui passent tous ici.
    if (previousTotal !== null && newTotal > previousTotal) {
      await this.readingStatusAutoUpdate.flipCaughtUpToReading(muId);
    }

    // Graphe de voisinage MU en arrière-plan (fire-and-forget) — **coût
    // réseau nul** : `data` contient DÉJÀ les trois champs de voisinage
    // (`recommendations`, `category_recommendations`, `related_series`), on
    // n'en lisait que le premier. Ce point est aussi celui qu'emprunte
    // l'hydratation nocturne (800 fiches/nuit), qui alimente donc le graphe
    // sans une requête de plus. Cf. `RecoGraphIngestService`.
    this.recoGraph
      .ingestSeriesPayload(muId, data)
      .catch((err) =>
        this.logger.warn(`Erreur ingestion graphe pour manga ${muId}: ${err}`),
      );

    return details;
  }

  /** Total officiel en base, ou `null` si la fiche n'existe pas encore. */
  private async readCurrentTotal(muId: number): Promise<number | null> {
    const row = await this.mangaRepository.findOne({
      where: { mu_id: muId.toString() },
      select: ['total_chapters'],
    });
    return row ? Number(row.total_chapters) || 0 : null;
  }

  async returnMangaIfExist(muId: string): Promise<Manga> {
    return await this.mangaRepository.findOneBy({
      mu_id: muId,
    });
  }

  /**
   * Upsert des recommandations MU **manuelles** (`recommendations`) pour un
   * manga source. Conservé comme point d'entrée public (fiche détail,
   * tests) ; l'écriture elle-même est déléguée à `RecoGraphIngestService`,
   * qui porte désormais les trois origines du graphe — stubs `manga`,
   * rattrapage des covers et upsert des liens compris.
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
    await this.recoGraph.saveManualLinks(
      sourceMuId,
      recos.map((reco) => ({
        seriesId: reco.series_id,
        title: reco.series_name ?? '',
        weight: reco.weight,
        smallCoverUrl: reco.small_cover_url ?? null,
        mediumCoverUrl: reco.medium_cover_url ?? null,
      })),
    );
  }

  /**
   * Liens du graphe en cache pour un manga source.
   *
   * **`kind = 'manual'` par défaut, et c'est essentiel** : depuis
   * l'ingestion des trois voisinages MU (2026-09-09), la table contient
   * aussi des liens `category` dont les poids sont d'un ordre de grandeur
   * mille fois supérieur (27 000-38 000 contre 1-220). Les rendre ici les
   * ferait entrer tels quels dans `RecommendationService.scoreRecos` et dans
   * les recos de la fiche détail, où ils écraseraient tout. Leur exploitation
   * passe par `RecoGraphCandidateService`, qui les normalise d'abord.
   */
  async getCachedRecommendations(
    sourceMuId: number,
    kinds: RecoLinkKind[] = ['manual'],
  ): Promise<MangaRecommendation[]> {
    return this.recoRepository
      .createQueryBuilder('mr')
      .where('mr.source_mu_id = :sourceMuId', {
        sourceMuId: sourceMuId.toString(),
      })
      .andWhere('mr.kind IN (:...kinds)', { kinds })
      .orderBy('mr.weight', 'DESC')
      .getMany();
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
   * les sauvegarde et les retourne. Utilisé quand le cache est absent.
   * @throws {MuRateLimitException} sur 429 MU (le caller doit temporiser) ;
   *   tout autre échec est avalé (`[]`) comme avant.
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
      // La réponse contient les TROIS voisinages : on les persiste tous
      // (`RecoGraphIngestService` fait le mapping plat/imbriqué du « format
      // MU 2026-05 » décrit dans `MangaDetailsDto.fromMU`), pour zéro requête
      // supplémentaire. Seuls les liens `manual` sont rendus à l'appelant —
      // le contrat de cette méthode est inchangé.
      await this.recoGraph.ingestSeriesPayload(muId, data);
      return this.getCachedRecommendations(muId);
    } catch (err) {
      if ((err as AxiosError)?.response?.status === 429) {
        throw new MuRateLimitException(muId);
      }
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
      try {
        return await this.fetchAndCacheRecommendations(muId);
      } catch (err) {
        // 429 MU : NE PAS propager au client. `GET /mangas/:id/recommendations`
        // doit renvoyer une liste (vide ici — les recos communautaires sont
        // ajoutées par `getRecommendationsAsQuickView`), pas un 429. Le rethrow
        // typé `MuRateLimitException` ne sert QUE les boucles de fetch du
        // `RecommendationService` (qui, elles, temporisent 5 s puis reprennent).
        if (err instanceof MuRateLimitException) {
          this.logger.warn(
            `Recos manga ${muId} indisponibles (MU 429) — dégradation gracieuse (liste communautaire seule)`,
          );
          return [];
        }
        throw err;
      }
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
    userId?: number,
  ): Promise<MangaQuickViewDto[]> {
    // **2026-05-19** : agrège désormais MU recos (max 5 par manga, limite
    // upstream MU) + community recos (mangas que les autres users de la
    // communauté possèdent aussi en biblio). Avant on était limité aux 5
    // de MU → user veut "toutes les recos de la communauté".
    let recos = await this.getRecommendationsForManga(muId);
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

    // Exclusion des titres écartés (« pas intéressé / déjà vu »). Les recos
    // de la fiche détail sont un chemin de recommandation à part entière :
    // sans ce filtre, un titre rejeté depuis la home réapparaîtrait ici.
    // `userId` optionnel — les appels internes sans contexte user ne
    // filtrent rien (comportement historique).
    if (userId !== undefined) {
      const dismissed = await this.dismissals.getDismissedMuIds(userId);
      if (dismissed.size > 0) {
        recos = recos.filter((r) => !dismissed.has(r.recommended_mu_id));
        if (!recos.length) return [];
      }
    }

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
