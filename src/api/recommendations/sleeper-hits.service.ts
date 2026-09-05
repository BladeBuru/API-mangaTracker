import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { MangasService } from '@/api/mangas/mangas.service';
import { MangaQuickViewDto } from '@/api/mangas/dto/manga-quick-view.dto';
import { CommunityRating } from '@/api/mangas/rating-aggregator';
import { DismissalService } from './dismissal.service';
import { computeTypeProfile, interleaveByTypeMix } from './type-profile';

/**
 * « Sleeper hits » (pépites récentes peu visibles) et **cold start**
 * (bibliothèque vide : top communauté + sleepers).
 *
 * Extrait de `RecommendationService` (2026-09-05) : le service dépassait
 * 880 lignes (limite repo : 600) et ces deux chemins n'ont rien en commun
 * avec le scoring par affinité — ils ne lisent pas les recommandations MU.
 * Contrat inchangé : `RecommendationService.findSleeperHits` délègue ici,
 * le controller n'a pas bougé.
 *
 * **Type de publication (2026-09-05)** : les sleepers respectent le profil
 * de type de la bibliothèque (`interleaveByTypeMix`) — un lecteur de manhwa
 * recevait exclusivement des mangas, le tri par score ne connaissant pas le
 * format. Le cold start reste neutre (aucun signal personnel).
 */
@Injectable()
export class SleeperHitsService {
  private readonly logger = new Logger(SleeperHitsService.name);

  /** Limite max de la pagination (alignée sur `RecommendationService`). */
  private static readonly MAX_LIMIT = 500;

  /**
   * Cold start (bibliothèque vide) : nombre minimum de votes locaux pour
   * qu'un manga remonte dans le pool « top communauté ». 5 votes = signal
   * suffisamment fiable sans exclure trop de titres.
   */
  private static readonly COLD_START_MIN_VOTES = 5;

  /**
   * Cold start : nombre de sleeper hits à concaténer après le top communauté
   * pour exposer aussi des découvertes récentes peu visibles.
   */
  private static readonly COLD_START_SLEEPER_BUDGET = 30;

  constructor(
    @InjectRepository(UserManga)
    private readonly userMangaRepository: Repository<UserManga>,
    @InjectRepository(MangaRecommendation)
    private readonly recoRepository: Repository<MangaRecommendation>,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    private readonly mangasService: MangasService,
    private readonly dismissals: DismissalService,
  ) {}

  /**
   * Trouve les "sleeper hits" : nouveautés récentes peu recommandées par la
   * communauté MU mais bien notées (globalement et/ou localement).
   *
   * Heuristique :
   *  1. Récent : `year >= currentYear - 2`
   *  2. Note MU élevée : `rating >= 7.5`
   *  3. Faible visibilité : apparaît dans < 5 lignes de `manga_recommendation`
   *  4. Pas dans la bibliothèque user (ni écarté)
   *
   * Score : `aggregated × log(localCount + 2) × recencyBoost`
   *  - `aggregated` : note Bayesian (MU + locaux)
   *  - `log(localCount + 2)` : booste les mangas avec votes locaux sans
   *    laisser un seul vote dominer
   *  - `recencyBoost = exp(-(now - year) / 2)` : préfère les sorties les plus
   *    récentes
   *
   * Puis sélection au prorata du profil de type de la bibliothèque.
   */
  async findSleeperHits(
    userId: number,
    limit = 20,
  ): Promise<MangaQuickViewDto[]> {
    const effectiveLimit = Math.min(limit, SleeperHitsService.MAX_LIMIT);
    const currentYear = new Date().getFullYear();
    const yearMin = currentYear - 2;
    const ratingMin = 7.5;
    const recoVisibilityThreshold = 5;

    // 1. Bibliothèque user + titres écartés → exclusion
    const userMangas = await this.userMangaRepository.find({
      where: { user: { id: userId } },
      relations: ['manga'],
    });
    const excludedMuIds = await this.dismissals.buildExclusionSet(
      userId,
      userMangas.map((um) => um.manga.mu_id),
    );
    const profile = computeTypeProfile(userMangas);

    // 2. Candidats : récents + bien notés + ni en biblio ni écartés
    const candidatesQuery = this.mangaRepository
      .createQueryBuilder('m')
      .where('m.year >= :yearMin', { yearMin })
      .andWhere('m.rating >= :ratingMin', { ratingMin });
    if (excludedMuIds.size > 0) {
      candidatesQuery.andWhere('m.mu_id NOT IN (:...lib)', {
        lib: Array.from(excludedMuIds),
      });
    }
    const candidates = await candidatesQuery.getMany();
    if (candidates.length === 0) return [];

    // 3. Compter les occurrences dans manga_recommendation (visibilité)
    const muIds = candidates.map((c) => c.mu_id);
    const recoCountRows: Array<{ mu_id: string; count: string }> =
      await this.recoRepository
        .createQueryBuilder('r')
        .select('r.recommended_mu_id', 'mu_id')
        .addSelect('COUNT(*)', 'count')
        .where('r.recommended_mu_id IN (:...ids)', { ids: muIds })
        .groupBy('r.recommended_mu_id')
        .getRawMany();
    const recoCountMap = new Map(
      recoCountRows.map((r) => [r.mu_id, parseInt(r.count, 10)]),
    );

    // 4. Filtrer les "cachés" (peu recommandés)
    const hidden = candidates.filter(
      (c) => (recoCountMap.get(c.mu_id) ?? 0) < recoVisibilityThreshold,
    );
    if (hidden.length === 0) return [];

    // 5. Enrichir avec community rating
    const muRatings = new Map(
      hidden.map((m) => [m.mu_id, Number(m.rating) || 0]),
    );
    const community = await this.mangasService.getCommunityRatings(
      hidden.map((m) => m.mu_id),
      muRatings,
    );

    // 6. Score sleeper
    type Scored = {
      manga: Manga;
      score: number;
      community: CommunityRating | undefined;
    };
    const scored: Scored[] = hidden
      .map((manga) => {
        const c = community.get(manga.mu_id);
        const aggregated = c?.aggregatedRating ?? Number(manga.rating);
        if (aggregated <= 0) return null;
        const localCount = c?.communityRatingCount ?? 0;
        const recencyBoost = Math.exp(-(currentYear - manga.year) / 2);
        const score = aggregated * Math.log(localCount + 2) * recencyBoost;
        return { manga, score, community: c };
      })
      .filter((s): s is Scored => s !== null);
    scored.sort((a, b) => b.score - a.score);

    // 7. Prorata du profil de type, puis top N → DTO (null-safe sur stubs)
    const balanced = interleaveByTypeMix(scored, (s) => s.manga.type, profile);
    return balanced
      .slice(0, effectiveLimit)
      .map((s) => this.toDto(s.manga, s.community));
  }

  /**
   * Fallback cold start : user sans bibliothèque (premier login, compte vide).
   *
   * Stratégie :
   *  1. Top communauté : mangas avec ≥ COLD_START_MIN_VOTES votes locaux,
   *     triés par note bayésienne décroissante (cf. `aggregateRating`).
   *  2. Sleepers : titres récents bien notés peu recommandés.
   *  3. Concat (top puis sleepers), dédup par muId, slice offset/limit.
   *
   * On évite de scorer par genre faute de signaux personnels : la priorité est
   * que la home ne soit jamais vide, et que la pagination remonte de nouveaux
   * candidats au fil du scroll.
   */
  async buildColdStartRecommendations(
    userId: number,
    limit: number,
    offset: number,
  ): Promise<MangaQuickViewDto[]> {
    // On charge plus large que offset+limit pour absorber les dédups et la
    // pagination ultérieure sans recalcul.
    const poolSize = Math.min(
      offset + limit + 50,
      SleeperHitsService.MAX_LIMIT * 3,
    );

    // Bibliothèque vide ne veut pas dire « rien à exclure » : un user peut
    // très bien écarter des titres AVANT d'avoir ajouté quoi que ce soit —
    // c'est même le cas d'usage typique (« One Piece, je l'ai vu en animé »).
    const dismissedMuIds = await this.dismissals.getDismissedMuIds(userId);

    const topDtos = await this.buildTopCommunityDtos(poolSize, dismissedMuIds);

    // Sleepers : `findSleeperHits` refait l'exclusion complète pour ce user
    // (biblio vide ∪ rejets).
    let sleepers: MangaQuickViewDto[] = [];
    try {
      sleepers = await this.findSleeperHits(
        userId,
        SleeperHitsService.COLD_START_SLEEPER_BUDGET,
      );
    } catch (err) {
      this.logger.warn(`Cold start: sleepers fetch failed: ${err}`);
    }

    const seen = new Set<number>(topDtos.map((d) => d.muId));
    const combined: MangaQuickViewDto[] = [
      ...topDtos,
      ...sleepers.filter((s) => !seen.has(s.muId)),
    ];

    return combined.slice(offset, offset + limit);
  }

  /**
   * Construit les DTOs des mangas les mieux notés par la communauté locale,
   * filtrés par un seuil minimum de votes pour éviter qu'un seul vote
   * extrême ne fasse remonter un titre confidentiel.
   *
   * Triés par note agrégée bayésienne (mélange MU + locaux).
   */
  private async buildTopCommunityDtos(
    maxRows: number,
    excludedMuIds: Set<string> = new Set(),
  ): Promise<MangaQuickViewDto[]> {
    const rows: Array<{ manga_id: string; avg: string; count: string }> =
      await this.userMangaRepository
        .createQueryBuilder('um')
        .select('um.manga_id::text', 'manga_id')
        .addSelect('AVG(um.user_rating)', 'avg')
        .addSelect('COUNT(*)', 'count')
        .where('um.user_rating > 0')
        .groupBy('um.manga_id')
        .having('COUNT(*) >= :min', {
          min: SleeperHitsService.COLD_START_MIN_VOTES,
        })
        .orderBy('AVG(um.user_rating)', 'DESC')
        .limit(maxRows)
        .getRawMany();
    if (rows.length === 0) return [];

    // Exclusion des titres écartés — le « top communauté » du cold start est
    // précisément là où One Piece / Naruto remontent en premier.
    const muIds = rows
      .map((r) => r.manga_id)
      .filter((muId) => !excludedMuIds.has(muId));
    if (muIds.length === 0) return [];
    const mangas = await this.mangaRepository.find({
      where: { mu_id: In(muIds) },
    });
    const mangaMap = new Map(mangas.map((m) => [m.mu_id, m]));
    const muRatings = new Map(
      mangas.map((m) => [m.mu_id, Number(m.rating) || 0]),
    );
    const community = await this.mangasService.getCommunityRatings(
      muIds,
      muRatings,
    );

    return muIds
      .map((muId) => {
        const m = mangaMap.get(muId);
        return m ? this.toDto(m, community.get(muId)) : null;
      })
      .filter((d): d is MangaQuickViewDto => d !== null)
      .sort((a, b) => (b.aggregatedRating ?? 0) - (a.aggregatedRating ?? 0));
  }

  /** Carte null-safe (stubs) + enrichissement communautaire. */
  private toDto(
    manga: Manga,
    community: CommunityRating | undefined,
  ): MangaQuickViewDto {
    const dto = MangaQuickViewDto.fromCatalog(manga);
    if (community) {
      if (community.communityRating !== null) {
        dto.communityRating = community.communityRating;
      }
      dto.communityRatingCount = community.communityRatingCount;
      dto.aggregatedRating = community.aggregatedRating;
    }
    return dto;
  }
}
