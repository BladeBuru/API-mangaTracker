import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { MangasService } from '@/api/mangas/mangas.service';
import { MangaQuickViewDto } from '@/api/mangas/dto/manga-quick-view.dto';
import { MuRateLimitException } from '@/api/mangas/exceptions/mu-rate-limit.exception';
import { RecoCacheService } from './reco-cache.service';
import {
  CatalogCandidate,
  CatalogCandidateService,
} from './catalog-candidate.service';

/**
 * Entrée scorée pour un manga candidat.
 * `sources` : map muId source → contribution au score (utilisé pour expliquer
 * « parce que vous avez aimé X, Y »).
 */
interface ScoredEntry {
  score: number;
  sources: Map<string, number>;
}

@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

  /**
   * Multiplicateur appliqué selon le statut de lecture.
   * Un manga `completed` ou `caughtUp` est un signal fort de goût.
   * Un manga juste planifié pèse moins.
   */
  private static readonly STATUS_MULTIPLIER: Record<string, number> = {
    completed: 1.5,
    caughtUp: 1.3,
    reading: 1.2,
    readLater: 0.8,
  };

  /**
   * Demi-vie de pertinence en jours. Un manga ajouté il y a 1 an a un poids ~0.37.
   * Les goûts évoluent — on favorise les mangas récemment ajoutés/mis à jour.
   */
  private static readonly RECENCY_HALF_LIFE_DAYS = 365;

  /**
   * Nombre maximum de recommandations remontées depuis un même manga source.
   *
   * **2026-05-19** : passé de 10 à 30. **2026-06-11 (hotfix-v0-10-1)** :
   * 30 → 40 — l'utilisateur trouvait le volume encore insuffisant avec
   * ~60 mangas en bibliothèque (l'exclusion biblio mange 20-40% du pool).
   * Les recos étant intrinsèquement subjectives, on préfère un pool large
   * + un tri par score que de filtrer en amont.
   *
   * Pool trop maigre malgré tout → complété par le catalogue local
   * (cf. `CATALOG_MIN_POOL` / `augmentWithCatalog`), qui a remplacé
   * l'ancien mécanisme de relax du cap (no-op en pratique).
   */
  private static readonly MAX_RECOS_PER_SOURCE = 40;

  /**
   * Seuil de pool sous lequel le scoring MU est complété par des candidats
   * du catalogue local (`CatalogCandidateService.findCandidates`). Le merge
   * n'additionne JAMAIS : un candidat déjà scoré par MU garde son score MU.
   */
  private static readonly CATALOG_MIN_POOL = 150;

  /** Limite max de la pagination. **2026-05-19** : 100 → 500. */
  private static readonly MAX_LIMIT = 500;

  // **2026-05-19 (correctif)** : on garde l'exclusion stricte des mangas
  // déjà en biblio (l'user ne veut PAS voir ce qu'il a déjà). Le vrai
  // problème était que MAX_RECOS_PER_SOURCE=10 + exclusion ne laissait
  // que ~3 recos après filtrage. La solution = élargir le cap par source
  // (30) pour qu'il reste un volume décent APRÈS exclusion biblio.

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

  /** Taille de batch pour les fetches MU bloquants. */
  private static readonly BATCH_SIZE = 5;

  /** Timeout par fetch MU (ms). */
  private static readonly FETCH_TIMEOUT_MS = 15000;

  /** Pause entre deux batches de fetch MU bloquants (ms). */
  private static readonly BATCH_DELAY_MS = 1000;

  /** Pause après un 429 MU avant le batch suivant (ms). */
  private static readonly RATE_LIMIT_DELAY_MS = 5000;

  /** Injectable pour les tests (évite les vrais timers). */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @InjectRepository(UserManga)
    private readonly userMangaRepository: Repository<UserManga>,
    @InjectRepository(MangaRecommendation)
    private readonly recoRepository: Repository<MangaRecommendation>,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    private readonly mangasService: MangasService,
    private readonly recoCache: RecoCacheService,
    private readonly catalogCandidates: CatalogCandidateService,
  ) {}

  /**
   * Trouve les "sleeper hits" : nouveautés récentes peu recommandées par la
   * communauté MU mais bien notées (globalement et/ou localement).
   *
   * Heuristique :
   *  1. Récent : `year >= currentYear - 2`
   *  2. Note MU élevée : `rating >= 7.5`
   *  3. Faible visibilité : apparaît dans < 5 lignes de `manga_recommendation`
   *  4. Pas dans la bibliothèque user
   *
   * Score : `aggregated × log(localCount + 2) × recencyBoost`
   *  - `aggregated` : note Bayesian (MU + locaux)
   *  - `log(localCount + 2)` : booste les mangas avec votes locaux sans
   *    laisser un seul vote dominer
   *  - `recencyBoost = exp(-(now - year) / 2)` : préfère les sorties les plus
   *    récentes
   */
  async findSleeperHits(
    userId: number,
    limit = 20,
  ): Promise<MangaQuickViewDto[]> {
    const effectiveLimit = Math.min(limit, RecommendationService.MAX_LIMIT);
    const currentYear = new Date().getFullYear();
    const yearMin = currentYear - 2;
    const ratingMin = 7.5;
    const recoVisibilityThreshold = 5;

    // 1. Bibliothèque user → exclusion
    const userMangas = await this.userMangaRepository.find({
      where: { user: { id: userId } },
      relations: ['manga'],
    });
    const libraryMuIds = new Set(userMangas.map((um) => um.manga.mu_id));

    // 2. Candidats : récents + bien notés + pas en biblio
    const candidatesQuery = this.mangaRepository
      .createQueryBuilder('m')
      .where('m.year >= :yearMin', { yearMin })
      .andWhere('m.rating >= :ratingMin', { ratingMin });
    if (libraryMuIds.size > 0) {
      candidatesQuery.andWhere('m.mu_id NOT IN (:...lib)', {
        lib: Array.from(libraryMuIds),
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
      community: ReturnType<typeof community.get>;
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

    // 7. Top N → DTO (null-safe sur stubs)
    return scored.slice(0, effectiveLimit).map((s) => {
      const dto = new MangaQuickViewDto();
      dto.muId = Number(s.manga.mu_id);
      dto.title = s.manga.title;
      dto.year = s.manga.year ?? 0;
      dto.mediumCoverUrl = s.manga.medium_cover_url ?? '';
      dto.largeCoverUrl = s.manga.medium_cover_url ?? '';
      dto.rating = s.manga.rating !== null ? Number(s.manga.rating) : 0;
      if (s.community) {
        if (s.community.communityRating !== null) {
          dto.communityRating = s.community.communityRating;
        }
        dto.communityRatingCount = s.community.communityRatingCount;
        dto.aggregatedRating = s.community.aggregatedRating;
      }
      return dto;
    });
  }

  /**
   * Construit et retourne une liste personnalisée de recommandations.
   *
   * Algorithme :
   * - Pour chaque manga de la bibliothèque user :
   *   - score_partiel = weight_MU × ratingMultiplier × statusMultiplier × recencyMultiplier
   *   - où ratingMultiplier dépend de la note locale (user_rating) ou de la
   *     note communautaire si non noté.
   * - Limite à MAX_RECOS_PER_SOURCE recos par manga source (diversité).
   * - Optionnellement filtré par genre.
   * - Trie par score décroissant, applique offset + limit.
   * - Tracke `recommendedBecauseOf` (top 3 mangas sources) pour explicabilité.
   *
   * Stratégie cache :
   * 1. Cache existant → réponse rapide. Fetches manquants en background.
   * 2. Cache vide → fetch bloquant batch=5 timeout=15s.
   */
  async buildUserRecommendations(
    userId: number,
    limit = 50,
    offset = 0,
    genreFilter?: string,
  ): Promise<MangaQuickViewDto[]> {
    const effectiveLimit = Math.min(limit, RecommendationService.MAX_LIMIT);
    const effectiveOffset = Math.max(0, offset);

    // Cache user-level (hotfix-v0-10-1 US-4) : TTL 1h, invalidé sur toute
    // mutation de la bibliothèque (cf. RecoCacheService).
    const variant = `flat:${
      genreFilter ?? 'all'
    }:${effectiveLimit}:${effectiveOffset}`;
    const cached = this.recoCache.get<MangaQuickViewDto[]>(userId, variant);
    if (cached) return cached;

    const userMangas = await this.userMangaRepository.find({
      where: { user: { id: userId } },
      relations: ['manga'],
    });

    if (userMangas.length === 0) {
      // Cold start : pas de signaux d'affinité personnelle. On remonte le
      // top communauté (notes locales agrégées) complété par des sleepers
      // récents, pour que l'écran ne soit jamais vide.
      return this.buildColdStartRecommendations(
        effectiveLimit,
        effectiveOffset,
      );
    }

    const libraryMuIds = new Set(userMangas.map((um) => um.manga.mu_id));
    const scoreMap = new Map<string, ScoredEntry>();
    const uncachedIds: number[] = [];

    // Première passe : cache
    await Promise.all(
      userMangas.map(async (um) => {
        const muId = Number(um.manga.mu_id);
        const cached = await this.mangasService.getCachedRecommendations(muId);
        if (cached.length === 0) {
          uncachedIds.push(muId);
          return;
        }
        this.scoreRecos(
          um.manga.mu_id,
          this.computeMultiplier(um),
          cached,
          libraryMuIds,
          scoreMap,
        );
      }),
    );

    if (scoreMap.size > 0) {
      if (uncachedIds.length > 0) {
        this.fetchUncachedInBackground(uncachedIds);
      }
      // Pool trop maigre → complément depuis le catalogue local.
      await this.augmentWithCatalog(userMangas, libraryMuIds, scoreMap);
      const result = await this.buildDtoFromScoreMap(
        scoreMap,
        effectiveLimit,
        effectiveOffset,
        genreFilter,
      );
      this.recoCache.set(userId, variant, result);
      return result;
    }

    // Cache totalement vide : fetch bloquant
    this.logger.log(
      `Cache vide pour userId=${userId}, fetch MU pour ${userMangas.length} manga(s)`,
    );
    await this.fetchAndScoreBlocking(userMangas, libraryMuIds, scoreMap);

    await this.augmentWithCatalog(userMangas, libraryMuIds, scoreMap);
    if (scoreMap.size === 0) return [];
    const result = await this.buildDtoFromScoreMap(
      scoreMap,
      effectiveLimit,
      effectiveOffset,
      genreFilter,
    );
    this.recoCache.set(userId, variant, result);
    return result;
  }

  /**
   * Calcule le scoreMap utilisateur (commun à `buildUserRecommendations` et
   * `buildUserRecommendationsByGenre`).
   *
   * Note : duplique partiellement la logique de `buildUserRecommendations`
   * pour éviter de la rappeler récursivement et limiter l'over-engineering.
   * Si une 3ème variante apparaît, factoriser proprement.
   */
  private async computeScoreMap(
    userId: number,
  ): Promise<Map<string, ScoredEntry>> {
    const userMangas = await this.userMangaRepository.find({
      where: { user: { id: userId } },
      relations: ['manga'],
    });
    if (userMangas.length === 0) return new Map();

    const libraryMuIds = new Set(userMangas.map((um) => um.manga.mu_id));
    const scoreMap = new Map<string, ScoredEntry>();
    const uncachedIds: number[] = [];

    await Promise.all(
      userMangas.map(async (um) => {
        const muId = Number(um.manga.mu_id);
        const cached = await this.mangasService.getCachedRecommendations(muId);
        if (cached.length === 0) {
          uncachedIds.push(muId);
          return;
        }
        this.scoreRecos(
          um.manga.mu_id,
          this.computeMultiplier(um),
          cached,
          libraryMuIds,
          scoreMap,
        );
      }),
    );

    if (scoreMap.size > 0) {
      if (uncachedIds.length > 0) this.fetchUncachedInBackground(uncachedIds);
      await this.augmentWithCatalog(userMangas, libraryMuIds, scoreMap);
      return scoreMap;
    }

    // Cache vide : fetch bloquant batché
    await this.fetchAndScoreBlocking(userMangas, libraryMuIds, scoreMap);
    await this.augmentWithCatalog(userMangas, libraryMuIds, scoreMap);
    return scoreMap;
  }

  /**
   * Fetch MU bloquant batché (batch = BATCH_SIZE, timeout par fetch) qui
   * alimente le scoreMap — factorisation des 2 anciennes boucles dupliquées
   * de `buildUserRecommendations` / `computeScoreMap`.
   *
   * Rythme : pause `BATCH_DELAY_MS` (1 s) entre les batches ; si MU répond
   * 429 (`MuRateLimitException` rethrow par `fetchAndCacheRecommendations`),
   * la pause passe à `RATE_LIMIT_DELAY_MS` (5 s) avant le batch suivant.
   */
  private async fetchAndScoreBlocking(
    userMangas: UserManga[],
    libraryMuIds: Set<string>,
    scoreMap: Map<string, ScoredEntry>,
  ): Promise<void> {
    for (
      let i = 0;
      i < userMangas.length;
      i += RecommendationService.BATCH_SIZE
    ) {
      const batch = userMangas.slice(i, i + RecommendationService.BATCH_SIZE);
      let rateLimited = false;
      await Promise.all(
        batch.map(async (um) => {
          const muId = Number(um.manga.mu_id);
          let recos: MangaRecommendation[];
          try {
            recos = await Promise.race([
              this.mangasService.fetchAndCacheRecommendations(muId),
              new Promise<MangaRecommendation[]>((_, reject) =>
                setTimeout(
                  () => reject(new Error('timeout')),
                  RecommendationService.FETCH_TIMEOUT_MS,
                ),
              ),
            ]);
          } catch (err) {
            if (err instanceof MuRateLimitException) rateLimited = true;
            this.logger.warn(`Reco fetch timeout/erreur pour ${muId}: ${err}`);
            return;
          }
          this.scoreRecos(
            um.manga.mu_id,
            this.computeMultiplier(um),
            recos,
            libraryMuIds,
            scoreMap,
          );
        }),
      );
      const hasNextBatch =
        i + RecommendationService.BATCH_SIZE < userMangas.length;
      if (hasNextBatch) {
        await this.sleep(
          rateLimited
            ? RecommendationService.RATE_LIMIT_DELAY_MS
            : RecommendationService.BATCH_DELAY_MS,
        );
      }
    }
  }

  /**
   * Complète le scoreMap avec des candidats du catalogue local quand le
   * scoring MU remonte moins de `CATALOG_MIN_POOL` entrées.
   *
   * Merge SANS addition : un candidat déjà scoré par MU garde son score MU
   * (les recos humaines priment sur l'affinité de genres). L'exclusion
   * stricte de la bibliothèque est conservée (défense en profondeur ici,
   * `findCandidates` exclut déjà via `excludeMuIds`).
   */
  private async augmentWithCatalog(
    userMangas: UserManga[],
    libraryMuIds: Set<string>,
    scoreMap: Map<string, ScoredEntry>,
  ): Promise<void> {
    if (scoreMap.size >= RecommendationService.CATALOG_MIN_POOL) return;

    let candidates: CatalogCandidate[];
    try {
      candidates = await this.catalogCandidates.findCandidates(
        userMangas,
        libraryMuIds,
      );
    } catch (err) {
      this.logger.warn(`Candidats catalogue indisponibles: ${err}`);
      return;
    }
    if (candidates.length === 0) return;

    let added = 0;
    for (const candidate of candidates) {
      if (scoreMap.has(candidate.mu_id)) continue; // MU prime — pas d'addition
      if (libraryMuIds.has(candidate.mu_id)) continue;
      const sources = new Map<string, number>();
      for (const sourceMuId of candidate.sourceMuIds) {
        sources.set(sourceMuId, candidate.score);
      }
      scoreMap.set(candidate.mu_id, { score: candidate.score, sources });
      added += 1;
    }
    if (added > 0) {
      this.logger.log(
        `Pool maigre — ${added} candidat(s) catalogue ajoutés (pool=${scoreMap.size})`,
      );
    }
  }

  /**
   * Variante segmentée : retourne les recommandations groupées par genre.
   *
   * @param topGenres Nombre max de genres à remonter (les plus représentés
   *   dans les recos triées par score).
   * @param perGenre Nombre max de mangas remontés par genre.
   *
   * Format de retour : `{ Action: [...], Romance: [...], ... }`.
   *
   * Filtre les genres NSFW (réutilise la liste `NSFW_GENRES` côté constants).
   * Un manga apparaît dans plusieurs sections s'il a plusieurs genres — c'est
   * voulu (UX home).
   */
  async buildUserRecommendationsByGenre(
    userId: number,
    topGenres = 5,
    perGenre = 10,
  ): Promise<Record<string, MangaQuickViewDto[]>> {
    // Cache user-level (hotfix-v0-10-1 US-4) — même politique que la liste
    // plate : TTL 1h, invalidation sur mutation bibliothèque.
    const variant = `byGenre:${topGenres}:${perGenre}`;
    const cachedResult = this.recoCache.get<
      Record<string, MangaQuickViewDto[]>
    >(userId, variant);
    if (cachedResult) return cachedResult;

    const scoreMap = await this.computeScoreMap(userId);
    if (scoreMap.size === 0) return {};

    // Tri initial par score
    const sorted = Array.from(scoreMap.entries())
      .map(([mu_id, entry]) => ({
        mu_id,
        score: entry.score,
        sources: entry.sources,
      }))
      .sort((a, b) => b.score - a.score);

    // Fetch tous les mangas pour récupérer leurs genres
    const muIds = sorted.map((s) => s.mu_id);
    const mangas = await this.mangaRepository.find({
      where: { mu_id: In(muIds) },
    });
    const mangaMap = new Map(mangas.map((m) => [m.mu_id, m]));

    // Liste NSFW à exclure (import au top du fichier ferait une dépendance
    // cyclique potentielle ; on garde la simple comparaison ici)
    const nsfwGenres = new Set([
      'Adult',
      'Mature',
      'Hentai',
      'Smut',
      'Yaoi',
      'Yuri',
      'Ecchi',
    ]);

    // Group by genre — score = max score d'un manga dans ce genre
    const genreGroups = new Map<
      string,
      Array<{ mu_id: string; score: number; sources: Map<string, number> }>
    >();
    for (const scored of sorted) {
      const m = mangaMap.get(scored.mu_id);
      if (!m?.genres || m.genres.length === 0) continue;
      for (const rawGenre of m.genres) {
        const genre = rawGenre.trim();
        if (!genre || nsfwGenres.has(genre)) continue;
        if (!genreGroups.has(genre)) genreGroups.set(genre, []);
        genreGroups.get(genre)!.push(scored);
      }
    }

    // Sélectionner les `topGenres` genres avec le plus de candidats
    const sortedGenres = Array.from(genreGroups.entries())
      .sort(([, a], [, b]) => b.length - a.length)
      .slice(0, topGenres);

    if (sortedGenres.length === 0) return {};

    // Enrichir tous les mangas top-N par genre (1 query par batch)
    const allTopMuIds = new Set<string>();
    const truncatedByGenre = new Map<
      string,
      Array<{ mu_id: string; score: number; sources: Map<string, number> }>
    >();
    for (const [genre, list] of sortedGenres) {
      const top = list.slice(0, perGenre);
      truncatedByGenre.set(genre, top);
      top.forEach((s) => allTopMuIds.add(s.mu_id));
    }

    const muRatings = new Map(
      mangas
        .filter((m) => allTopMuIds.has(m.mu_id))
        .map((m) => [m.mu_id, Number(m.rating) || 0]),
    );
    const community = await this.mangasService.getCommunityRatings(
      Array.from(allTopMuIds),
      muRatings,
    );

    // Construire les sources titles map
    const allSourceMuIds = new Set<string>();
    for (const list of truncatedByGenre.values()) {
      for (const s of list) {
        for (const sourceId of s.sources.keys()) allSourceMuIds.add(sourceId);
      }
    }
    const sourceMangas =
      allSourceMuIds.size > 0
        ? await this.mangaRepository.find({
            where: { mu_id: In(Array.from(allSourceMuIds)) },
          })
        : [];
    const sourceTitleMap = new Map(sourceMangas.map((m) => [m.mu_id, m.title]));

    // Build result
    // NB : les stubs (issus de saveRecommendations) n'ont pas de genres tant
    // que getMangaDetails n'a pas tourné — ils sont donc filtrés à l'étape
    // de regroupement par genre plus haut. La null-safety ci-dessous est de
    // la défense en profondeur (au cas où un manga existant aurait des
    // covers null).
    const result: Record<string, MangaQuickViewDto[]> = {};
    for (const [genre, list] of truncatedByGenre) {
      result[genre] = list
        .map((scored) => {
          const m = mangaMap.get(scored.mu_id);
          if (!m) return null;
          const dto = new MangaQuickViewDto();
          dto.muId = Number(scored.mu_id);
          dto.title = m.title;
          dto.year = m.year ?? 0;
          dto.mediumCoverUrl = m.medium_cover_url ?? '';
          dto.largeCoverUrl = m.medium_cover_url ?? '';
          dto.rating = m.rating !== null ? Number(m.rating) : 0;
          const topSources = Array.from(scored.sources.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([id]) => sourceTitleMap.get(id))
            .filter((t): t is string => Boolean(t));
          if (topSources.length > 0) dto.recommendedBecauseOf = topSources;
          const c = community.get(scored.mu_id);
          if (c) {
            if (c.communityRating !== null)
              dto.communityRating = c.communityRating;
            dto.communityRatingCount = c.communityRatingCount;
            dto.aggregatedRating = c.aggregatedRating;
          }
          return dto;
        })
        .filter((dto): dto is MangaQuickViewDto => dto !== null);
    }

    this.recoCache.set(userId, variant, result);
    return result;
  }

  /**
   * Calcule le multiplicateur global appliqué aux recommandations d'un manga
   * source.
   * `m_total = m_rating × m_status × m_recency`
   */
  private computeMultiplier(um: UserManga): number {
    const ratingMultiplier = um.user_rating > 0 ? um.user_rating / 5.0 : 1.0;
    const statusMultiplier =
      RecommendationService.STATUS_MULTIPLIER[um.readingStatus] ?? 1.0;
    const ageDays = (Date.now() - um.adding_date.getTime()) / 86_400_000;
    const recencyMultiplier = Math.exp(
      -ageDays / RecommendationService.RECENCY_HALF_LIFE_DAYS,
    );
    return ratingMultiplier * statusMultiplier * recencyMultiplier;
  }

  /**
   * Applique les recos d'un manga source au scoreMap, en limitant la
   * contribution à `MAX_RECOS_PER_SOURCE` pour la diversité.
   */
  private scoreRecos(
    sourceMuId: string,
    multiplier: number,
    recos: MangaRecommendation[],
    libraryMuIds: Set<string>,
    scoreMap: Map<string, ScoredEntry>,
  ): void {
    const topRecos = [...recos]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, RecommendationService.MAX_RECOS_PER_SOURCE);

    for (const reco of topRecos) {
      // Exclusion stricte des mangas déjà en biblio : l'user ne veut pas
      // voir ce qu'il a déjà. Le volume restant après filtrage est garanti
      // par MAX_RECOS_PER_SOURCE=30 (au lieu de 10) pour qu'il reste assez
      // de candidats même après exclusion (ex: 30 - ~10 déjà-lus = 20).
      if (libraryMuIds.has(reco.recommended_mu_id)) continue;
      const contribution = reco.weight * multiplier;
      let entry = scoreMap.get(reco.recommended_mu_id);
      if (!entry) {
        entry = { score: 0, sources: new Map() };
        scoreMap.set(reco.recommended_mu_id, entry);
      }
      entry.score += contribution;
      entry.sources.set(
        sourceMuId,
        (entry.sources.get(sourceMuId) ?? 0) + contribution,
      );
    }
  }

  /**
   * Lance les fetches MU manquants en arrière-plan sans bloquer la réponse.
   *
   * Le `Promise.resolve().then()` enveloppe chaque appel pour que tout throw
   * synchrone soit capturé par le `.catch` suivant.
   */
  private fetchUncachedInBackground(muIds: number[]): void {
    for (const id of muIds) {
      Promise.resolve()
        .then(() => this.mangasService.fetchAndCacheRecommendations(id))
        .catch((err) =>
          this.logger.warn(`Fetch background échoué pour ${id}: ${err}`),
        );
    }
  }

  /**
   * Construit les DTOs depuis le scoreMap trié, en remontant le top 3 des
   * mangas sources comme champ `recommendedBecauseOf`.
   */
  private async buildDtoFromScoreMap(
    scoreMap: Map<string, ScoredEntry>,
    limit: number,
    offset: number,
    genreFilter?: string,
  ): Promise<MangaQuickViewDto[]> {
    let sorted = Array.from(scoreMap.entries())
      .map(([mu_id, entry]) => ({
        mu_id,
        score: entry.score,
        sources: entry.sources,
      }))
      .sort((a, b) => b.score - a.score);

    if (sorted.length === 0) return [];

    let mangaMap: Map<string, Manga>;

    if (genreFilter) {
      // Avec filtre genre : il faut fetcher tous les candidats AVANT slice,
      // sinon on perd des mangas pertinents au-delà de l'offset.
      const allMuIds = sorted.map((s) => s.mu_id);
      const allMangas = await this.mangaRepository.find({
        where: { mu_id: In(allMuIds) },
      });
      mangaMap = new Map(allMangas.map((m) => [m.mu_id, m]));

      const normalized = genreFilter.trim().toLowerCase();
      sorted = sorted.filter((s) => {
        const m = mangaMap.get(s.mu_id);
        if (!m?.genres) return false;
        return m.genres.some((g) => g.toLowerCase() === normalized);
      });
      if (sorted.length === 0) return [];
      sorted = sorted.slice(offset, offset + limit);
    } else {
      // Sans filtre : slice direct, ne fetcher que ce qui est nécessaire
      sorted = sorted.slice(offset, offset + limit);
      const targetMuIds = sorted.map((s) => s.mu_id);
      const mangas = await this.mangaRepository.find({
        where: { mu_id: In(targetMuIds) },
      });
      mangaMap = new Map(mangas.map((m) => [m.mu_id, m]));
    }

    const sourceMuIds = Array.from(
      new Set(sorted.flatMap((s) => Array.from(s.sources.keys()))),
    );
    const sourceMangas =
      sourceMuIds.length > 0
        ? await this.mangaRepository.find({
            where: { mu_id: In(sourceMuIds) },
          })
        : ([] as Manga[]);
    const sourceTitleMap = new Map(sourceMangas.map((m) => [m.mu_id, m.title]));

    // Enrichissement note communautaire (Bayesian aggregation MU + locaux)
    const finalMuIds = sorted.map((s) => s.mu_id);
    const muRatings = new Map(
      finalMuIds
        .map((id) => {
          const m = mangaMap.get(id);
          return m ? ([id, Number(m.rating) || 0] as [string, number]) : null;
        })
        .filter((p): p is [string, number] => p !== null),
    );
    const communityRatings = await this.mangasService.getCommunityRatings(
      finalMuIds,
      muRatings,
    );

    return sorted
      .map((scored) => {
        const manga = mangaMap.get(scored.mu_id);
        if (!manga) return null;
        const dto = new MangaQuickViewDto();
        dto.muId = Number(scored.mu_id);
        dto.title = manga.title;
        // Stubs : year/rating/cover peuvent être null tant que getMangaDetails
        // n'a pas été appelé. On expose 0 / '' pour rester compatible avec le
        // contract du DTO (Flutter affiche un placeholder pour les covers
        // vides, et 0 pour year/rating jusqu'au premier clic).
        dto.year = manga.year ?? 0;
        dto.mediumCoverUrl = manga.medium_cover_url ?? '';
        dto.largeCoverUrl = manga.medium_cover_url ?? '';
        dto.rating = manga.rating !== null ? Number(manga.rating) : 0;
        const topSources = Array.from(scored.sources.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([muId]) => sourceTitleMap.get(muId))
          .filter((t): t is string => Boolean(t));
        if (topSources.length > 0) {
          dto.recommendedBecauseOf = topSources;
        }
        const community = communityRatings.get(scored.mu_id);
        if (community) {
          if (community.communityRating !== null) {
            dto.communityRating = community.communityRating;
          }
          dto.communityRatingCount = community.communityRatingCount;
          dto.aggregatedRating = community.aggregatedRating;
        }
        return dto;
      })
      .filter((dto): dto is MangaQuickViewDto => dto !== null);
  }

  /**
   * Fallback cold start : user sans bibliothèque (premier login, compte vide).
   *
   * Stratégie :
   *  1. Top communauté : mangas avec ≥ COLD_START_MIN_VOTES votes locaux,
   *     triés par note bayésienne décroissante (cf. `aggregateRating`).
   *  2. Sleepers : titres récents bien notés peu recommandés (cf. `findSleeperHits`).
   *  3. Concat (top puis sleepers), dédup par muId, slice offset/limit.
   *
   * On évite de scorer par genre faute de signaux personnels : la priorité est
   * que la home ne soit jamais vide, et que la pagination remonte de nouveaux
   * candidats au fil du scroll.
   */
  private async buildColdStartRecommendations(
    limit: number,
    offset: number,
  ): Promise<MangaQuickViewDto[]> {
    // On charge plus large que offset+limit pour absorber les dédups et la
    // pagination ultérieure sans recalcul.
    const poolSize = Math.min(
      offset + limit + 50,
      RecommendationService.MAX_LIMIT * 3,
    );

    const topDtos = await this.buildTopCommunityDtos(poolSize);

    // Sleepers : userId sentinelle -1 = aucune biblio à exclure.
    let sleepers: MangaQuickViewDto[] = [];
    try {
      sleepers = await this.findSleeperHits(
        -1,
        RecommendationService.COLD_START_SLEEPER_BUDGET,
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
          min: RecommendationService.COLD_START_MIN_VOTES,
        })
        .orderBy('AVG(um.user_rating)', 'DESC')
        .limit(maxRows)
        .getRawMany();

    if (rows.length === 0) return [];

    const muIds = rows.map((r) => r.manga_id);
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
        if (!m) return null;
        const c = community.get(muId);
        const dto = new MangaQuickViewDto();
        dto.muId = Number(muId);
        dto.title = m.title;
        dto.year = m.year ?? 0;
        dto.mediumCoverUrl = m.medium_cover_url ?? '';
        dto.largeCoverUrl = m.medium_cover_url ?? '';
        dto.rating = m.rating !== null ? Number(m.rating) : 0;
        if (c) {
          if (c.communityRating !== null)
            dto.communityRating = c.communityRating;
          dto.communityRatingCount = c.communityRatingCount;
          dto.aggregatedRating = c.aggregatedRating;
        }
        return dto;
      })
      .filter((d): d is MangaQuickViewDto => d !== null)
      .sort((a, b) => (b.aggregatedRating ?? 0) - (a.aggregatedRating ?? 0));
  }
}
