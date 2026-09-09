import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { MangasService } from '@/api/mangas/mangas.service';
import { MangaQuickViewDto } from '@/api/mangas/dto/manga-quick-view.dto';
import { MuRateLimitException } from '@/api/mangas/exceptions/mu-rate-limit.exception';
import { RecoCacheService } from './reco-cache.service';
import {
  CatalogCandidate,
  CatalogCandidateService,
} from './catalog-candidate.service';
import { GenreSectionService } from './genre-section.service';
import { DismissalService } from './dismissal.service';
import { RecoGraphCandidateService } from './reco-graph-candidate.service';
import { RecommendationDtoBuilderService } from './recommendation-dto-builder.service';
import { computeAffinityMultiplier } from './library-affinity';
import { byValueDescThenId, compareIdAsc } from './reco-ordering';
import { ScoredEntry } from './scored-entry.interface';
import { SleeperHitsService } from './sleeper-hits.service';
import { computeTypeProfile } from './type-profile';

/**
 * Recommandations personnalisées — scoring par affinité à partir des
 * recommandations MangaUpdates des titres de la bibliothèque, complété par
 * le catalogue local quand le pool est maigre.
 *
 * Découpage (2026-09-05, limite repo de 600 lignes) :
 *  - `SleeperHitsService` : sleepers + cold start (délégués ici) ;
 *  - `RecommendationDtoBuilderService` : pool scoré → cartes (tri, prorata de
 *    type, filtre genre, pagination, explicabilité, communauté) ;
 *  - `GenreSectionService` : sections de la home segmentée ;
 *  - `CatalogCandidateService` : candidats catalogue par genres ET par type.
 *
 * **Type de publication (2026-09-05)** : le profil de type de la
 * bibliothèque (`computeTypeProfile`) est calculé une fois par requête et
 * transmis aux sélections — un lecteur de manhwa recevait exclusivement des
 * mangas, le scoring ne connaissant pas le format.
 */
@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

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
    private readonly mangasService: MangasService,
    private readonly recoCache: RecoCacheService,
    private readonly catalogCandidates: CatalogCandidateService,
    private readonly recoGraph: RecoGraphCandidateService,
    private readonly genreSections: GenreSectionService,
    private readonly dismissals: DismissalService,
    private readonly sleepers: SleeperHitsService,
    private readonly dtoBuilder: RecommendationDtoBuilderService,
  ) {}

  /**
   * Set d'exclusion d'un utilisateur = bibliothèque ∪ titres écartés
   * (« pas intéressé / déjà vu »).
   *
   * **Point d'entrée unique de l'exclusion.** Tous les chemins de reco de ce
   * service partent de ce set, qui se propage ensuite tel quel dans
   * `scoreRecos`, `augmentWithCatalog` → `CatalogCandidateService`, et
   * `GenreSectionService`. Aucune branche aval ne reconstruit d'exclusion :
   * c'est ce qui garantit qu'un titre rejeté ne peut réapparaître nulle part.
   */
  private buildExclusionSet(
    userId: number,
    userMangas: UserManga[],
  ): Promise<Set<string>> {
    return this.dismissals.buildExclusionSet(
      userId,
      userMangas.map((um) => um.manga.mu_id),
    );
  }

  /**
   * Bibliothèque d'un utilisateur, **ordonnée par `mu_id` croissant**.
   *
   * L'ordre importe : les contributions de chaque titre source sont
   * ADDITIONNÉES au score des candidats, et l'addition flottante n'est pas
   * associative — deux ordres d'accumulation donnent des scores qui diffèrent
   * au dernier bit, donc un classement différent entre deux ex æquo. Or
   * `find()` sans `ORDER BY` ne garantit aucun ordre.
   */
  private async loadLibrary(userId: number): Promise<UserManga[]> {
    const userMangas = await this.userMangaRepository.find({
      where: { user: { id: userId } },
      relations: ['manga'],
    });
    return userMangas.sort((a, b) =>
      compareIdAsc(a.manga?.mu_id ?? '', b.manga?.mu_id ?? ''),
    );
  }

  /**
   * Première passe de scoring : lecture des recos MU déjà en cache.
   *
   * Les lectures restent **parallèles** (une par titre de bibliothèque), mais
   * le scoring est appliqué **séquentiellement dans l'ordre de la
   * bibliothèque** au lieu de l'être dans l'ordre d'arrivée des réponses.
   * Avant, l'ordre d'insertion du `scoreMap` — et l'ordre des additions
   * flottantes — dépendait d'une course entre requêtes : deux appels
   * identiques ne produisaient pas exactement le même pool.
   *
   * @returns les `mu_id` sans reco en cache, à rattraper en tâche de fond.
   */
  private async scoreFromCache(
    userMangas: UserManga[],
    excludedMuIds: Set<string>,
    scoreMap: Map<string, ScoredEntry>,
  ): Promise<number[]> {
    const cachedPerSource = await Promise.all(
      userMangas.map((um) =>
        this.mangasService.getCachedRecommendations(Number(um.manga.mu_id)),
      ),
    );

    const uncachedIds: number[] = [];
    cachedPerSource.forEach((cached, index) => {
      const um = userMangas[index];
      if (cached.length === 0) {
        uncachedIds.push(Number(um.manga.mu_id));
        return;
      }
      this.scoreRecos(
        um.manga.mu_id,
        computeAffinityMultiplier(um),
        cached,
        excludedMuIds,
        scoreMap,
      );
    });
    return uncachedIds;
  }

  /**
   * « Sleeper hits » — pépites récentes peu visibles. Délégué à
   * `SleeperHitsService` (contrat inchangé pour le controller).
   */
  findSleeperHits(userId: number, limit = 20): Promise<MangaQuickViewDto[]> {
    return this.sleepers.findSleeperHits(userId, limit);
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
   * - Sélection au prorata du profil de type (manga / manhwa / manhua).
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

    const userMangas = await this.loadLibrary(userId);

    if (userMangas.length === 0) {
      // Cold start : pas de signaux d'affinité personnelle. On remonte le
      // top communauté (notes locales agrégées) complété par des sleepers
      // récents, pour que l'écran ne soit jamais vide.
      return this.sleepers.buildColdStartRecommendations(
        userId,
        effectiveLimit,
        effectiveOffset,
      );
    }

    const excludedMuIds = await this.buildExclusionSet(userId, userMangas);
    const scoreMap = new Map<string, ScoredEntry>();

    // Première passe : cache
    const uncachedIds = await this.scoreFromCache(
      userMangas,
      excludedMuIds,
      scoreMap,
    );

    // Graphe de voisinage MU (`category` + `related`) — BDD seule, aucun
    // appel réseau. Placé AVANT l'arbitrage cache/fetch bloquant : quand le
    // graphe répond, il n'y a plus de raison de faire attendre l'utilisateur
    // le temps de 68 fiches MU.
    await this.recoGraph.augment(userMangas, excludedMuIds, scoreMap);

    if (scoreMap.size > 0) {
      if (uncachedIds.length > 0) {
        this.fetchUncachedInBackground(uncachedIds);
      }
    } else {
      // Cache totalement vide : fetch bloquant
      this.logger.log(
        `Cache vide pour userId=${userId}, fetch MU pour ${userMangas.length} manga(s)`,
      );
      await this.fetchAndScoreBlocking(userMangas, excludedMuIds, scoreMap);
    }

    // Pool trop maigre → complément depuis le catalogue local.
    await this.augmentWithCatalog(userMangas, excludedMuIds, scoreMap);
    if (scoreMap.size === 0) return [];
    const result = await this.dtoBuilder.build(scoreMap, {
      limit: effectiveLimit,
      offset: effectiveOffset,
      genreFilter,
      profile: computeTypeProfile(userMangas),
    });
    this.recoCache.set(userId, variant, result);
    return result;
  }

  /**
   * Calcule le scoreMap utilisateur (utilisé par
   * `buildUserRecommendationsByGenre`). Retourne aussi la bibliothèque
   * chargée pour éviter une seconde requête côté `GenreSectionService`
   * (classement des genres favoris + exclusion biblio).
   *
   * Note : duplique partiellement la logique de `buildUserRecommendations`
   * pour éviter de la rappeler récursivement et limiter l'over-engineering.
   * Si une 3ème variante apparaît, factoriser proprement.
   */
  private async computeScoreMap(userId: number): Promise<{
    scoreMap: Map<string, ScoredEntry>;
    userMangas: UserManga[];
    excludedMuIds: Set<string>;
  }> {
    const userMangas = await this.loadLibrary(userId);
    if (userMangas.length === 0) {
      return { scoreMap: new Map(), userMangas, excludedMuIds: new Set() };
    }

    const excludedMuIds = await this.buildExclusionSet(userId, userMangas);
    const scoreMap = new Map<string, ScoredEntry>();

    const uncachedIds = await this.scoreFromCache(
      userMangas,
      excludedMuIds,
      scoreMap,
    );

    // Même ordre que la liste plate : graphe MU d'abord (BDD seule).
    await this.recoGraph.augment(userMangas, excludedMuIds, scoreMap);

    if (scoreMap.size > 0) {
      if (uncachedIds.length > 0) this.fetchUncachedInBackground(uncachedIds);
      await this.augmentWithCatalog(userMangas, excludedMuIds, scoreMap);
      return { scoreMap, userMangas, excludedMuIds };
    }

    // Cache vide : fetch bloquant batché
    await this.fetchAndScoreBlocking(userMangas, excludedMuIds, scoreMap);
    await this.augmentWithCatalog(userMangas, excludedMuIds, scoreMap);
    return { scoreMap, userMangas, excludedMuIds };
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
    excludedMuIds: Set<string>,
    scoreMap: Map<string, ScoredEntry>,
  ): Promise<void> {
    for (
      let i = 0;
      i < userMangas.length;
      i += RecommendationService.BATCH_SIZE
    ) {
      const batch = userMangas.slice(i, i + RecommendationService.BATCH_SIZE);
      let rateLimited = false;
      // Fetches parallèles, scoring séquentiel : comme `scoreFromCache`, on
      // ne laisse pas l'ordre d'arrivée des réponses MU décider de l'ordre
      // des additions de score (voir `loadLibrary`).
      const fetched = await Promise.all(
        batch.map(async (um) => {
          const muId = Number(um.manga.mu_id);
          try {
            return await Promise.race([
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
            return null;
          }
        }),
      );
      fetched.forEach((recos, index) => {
        if (recos === null) return;
        const um = batch[index];
        this.scoreRecos(
          um.manga.mu_id,
          computeAffinityMultiplier(um),
          recos,
          excludedMuIds,
          scoreMap,
        );
      });
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
    excludedMuIds: Set<string>,
    scoreMap: Map<string, ScoredEntry>,
  ): Promise<void> {
    if (scoreMap.size >= RecommendationService.CATALOG_MIN_POOL) return;

    let candidates: CatalogCandidate[];
    try {
      candidates = await this.catalogCandidates.findCandidates(
        userMangas,
        excludedMuIds,
      );
    } catch (err) {
      this.logger.warn(`Candidats catalogue indisponibles: ${err}`);
      return;
    }
    if (candidates.length === 0) return;

    let added = 0;
    for (const candidate of candidates) {
      if (scoreMap.has(candidate.mu_id)) continue; // MU prime — pas d'addition
      if (excludedMuIds.has(candidate.mu_id)) continue;
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
   * Variante segmentée : retourne les recommandations groupées par genre
   * pour la home. La construction des sections est déléguée à
   * `GenreSectionService`.
   *
   * **Fix 2026-08-25** (« mêmes titres dans toutes les sections ») : dédup
   * par mu_id, exclusivité inter-sections (un manga n'apparaît que dans la
   * section de son genre le mieux classé) et complément des sections sous
   * `perGenre` par le catalogue local — voir
   * `GenreSectionService.buildSections`.
   *
   * @param topGenres Nombre max de genres remontés (genres favoris de la
   *   biblio, fallback sur la représentation dans le pool).
   * @param perGenre Nombre max de mangas remontés par genre.
   *
   * Format de retour inchangé : `{ Action: [...], Romance: [...], ... }`.
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

    const { scoreMap, userMangas, excludedMuIds } = await this.computeScoreMap(
      userId,
    );
    if (scoreMap.size === 0) return {};

    // `excludedMuIds` (biblio ∪ rejets) est transmis explicitement : sans
    // lui, `GenreSectionService` reconstruirait une exclusion « biblio
    // seule » et les compléments catalogue des sections déficitaires
    // pourraient réintroduire un titre écarté.
    const result = await this.genreSections.buildSections(
      scoreMap,
      userMangas,
      topGenres,
      perGenre,
      excludedMuIds,
    );
    this.recoCache.set(userId, variant, result);
    return result;
  }

  /**
   * Applique les recos d'un manga source au scoreMap, en limitant la
   * contribution à `MAX_RECOS_PER_SOURCE` pour la diversité.
   */
  private scoreRecos(
    sourceMuId: string,
    multiplier: number,
    recos: MangaRecommendation[],
    excludedMuIds: Set<string>,
    scoreMap: Map<string, ScoredEntry>,
  ): void {
    const topRecos = [...recos]
      .sort(
        byValueDescThenId<MangaRecommendation>(
          (reco) => reco.weight,
          (reco) => reco.recommended_mu_id,
        ),
      )
      .slice(0, RecommendationService.MAX_RECOS_PER_SOURCE);

    for (const reco of topRecos) {
      // Exclusion stricte des mangas déjà en biblio : l'user ne veut pas
      // voir ce qu'il a déjà. Le volume restant après filtrage est garanti
      // par MAX_RECOS_PER_SOURCE=30 (au lieu de 10) pour qu'il reste assez
      // de candidats même après exclusion (ex: 30 - ~10 déjà-lus = 20).
      if (excludedMuIds.has(reco.recommended_mu_id)) continue;
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
}
