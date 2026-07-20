import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { NSFW_GENRES } from '@/api/mangas/constants';

/**
 * Candidat issu du catalogue local (table `manga` alimentée par
 * CatalogSyncService), scoré par affinité de genres avec la bibliothèque.
 */
export interface CatalogCandidate {
  mu_id: string;
  score: number;
  /**
   * mu_id des 2 mangas biblio au multiplicateur le plus élevé partageant le
   * genre dominant du candidat — alimente `recommendedBecauseOf`.
   */
  sourceMuIds: string[];
}

/**
 * Complète le pool de recommandations MU (longue traîne) avec des candidats
 * du catalogue local quand le scoring MU remonte trop peu de titres
 * (< CATALOG_MIN_POOL côté RecommendationService).
 *
 * Score : `CATALOG_BASE_WEIGHT × genreScore × (0.5 + 0.5 × ratingBoost)`
 * - `genreScore` = Σ share(g) des genres favoris matchés (share = part du
 *   genre dans les occurrences de la biblio) ;
 * - `ratingBoost` = clamp((rating − 6.5) / 3.5, 0, 1).
 * Plage effective ~0.5-6 : complète sans jamais doubler une reco MU forte
 * (contributions typiques 2-25).
 */
@Injectable()
export class CatalogCandidateService {
  private readonly logger = new Logger(CatalogCandidateService.name);

  /** Poids de base d'un candidat catalogue (vs weight MU 2-25). */
  private static readonly CATALOG_BASE_WEIGHT = 8;

  /** Note MU minimale d'un candidat catalogue. */
  private static readonly RATING_FLOOR = 7.0;

  /** Nombre de genres favoris considérés. */
  private static readonly TOP_GENRES = 5;

  /** Lignes max remontées par la requête (seq scan ok < 100k lignes). */
  private static readonly QUERY_LIMIT = 300;

  /** Nombre de mangas sources exposés par candidat (explicabilité). */
  private static readonly SOURCES_PER_CANDIDATE = 2;

  /**
   * Miroir de `RecommendationService.STATUS_MULTIPLIER` /
   * `RECENCY_HALF_LIFE_DAYS` — utilisé uniquement pour choisir les mangas
   * sources les plus représentatifs (pas pour le score du candidat).
   */
  private static readonly STATUS_MULTIPLIER: Record<string, number> = {
    completed: 1.5,
    caughtUp: 1.3,
    reading: 1.2,
    readLater: 0.8,
  };

  private static readonly RECENCY_HALF_LIFE_DAYS = 365;

  constructor(
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
  ) {}

  /**
   * Candidats du catalogue local matchant les genres favoris de la biblio.
   *
   * Requête : genres non null, au moins un genre favori (`?|`), aucun genre
   * NSFW, rating ≥ 7.0, hors bibliothèque, tri rating DESC LIMIT 300.
   */
  async findCandidates(
    userMangas: UserManga[],
    excludeMuIds: Set<string>,
    maxCandidates = 200,
  ): Promise<CatalogCandidate[]> {
    const shares = this.computeGenreShares(userMangas);
    if (shares.size === 0) return [];
    const topGenres = Array.from(shares.keys());

    const qb = this.mangaRepository
      .createQueryBuilder('m')
      .where('m.genres IS NOT NULL')
      .andWhere('m.genres::jsonb ?| ARRAY[:...topGenres]', { topGenres })
      .andWhere('NOT (m.genres::jsonb ?| ARRAY[:...nsfwGenres])', {
        nsfwGenres: NSFW_GENRES,
      })
      .andWhere('m.rating >= :ratingFloor', {
        ratingFloor: CatalogCandidateService.RATING_FLOOR,
      });
    if (excludeMuIds.size > 0) {
      qb.andWhere('m.mu_id NOT IN (:...excludeMuIds)', {
        excludeMuIds: Array.from(excludeMuIds),
      });
    }
    const candidates = await qb
      .orderBy('m.rating', 'DESC')
      .limit(CatalogCandidateService.QUERY_LIMIT)
      .getMany();

    if (candidates.length === 0) return [];

    const sourcesByGenre = this.buildSourcesByGenre(userMangas, topGenres);
    const scored: CatalogCandidate[] = [];
    for (const manga of candidates) {
      const matched = (manga.genres ?? []).filter((g) => shares.has(g));
      if (matched.length === 0) continue;
      let genreScore = 0;
      let dominantGenre = matched[0];
      let bestShare = 0;
      for (const genre of matched) {
        const share = shares.get(genre) ?? 0;
        genreScore += share;
        if (share > bestShare) {
          bestShare = share;
          dominantGenre = genre;
        }
      }
      const rating = Number(manga.rating) || 0;
      const ratingBoost = Math.min(Math.max((rating - 6.5) / 3.5, 0), 1);
      const score =
        CatalogCandidateService.CATALOG_BASE_WEIGHT *
        genreScore *
        (0.5 + 0.5 * ratingBoost);
      scored.push({
        mu_id: manga.mu_id,
        score,
        sourceMuIds: sourcesByGenre.get(dominantGenre) ?? [],
      });
    }

    scored.sort((a, b) => b.score - a.score);
    this.logger.log(
      `Catalogue : ${scored.length} candidat(s) pour genres [${topGenres.join(
        ', ',
      )}]`,
    );
    return scored.slice(0, maxCandidates);
  }

  /**
   * Genres favoris de la biblio (pattern `computeGenreCounts` des stats) :
   * top 5 par occurrences, share(g) = count(g) / totalOccurrences.
   */
  private computeGenreShares(userMangas: UserManga[]): Map<string, number> {
    const counts = new Map<string, number>();
    let total = 0;
    for (const um of userMangas) {
      for (const genre of um.manga?.genres ?? []) {
        if (!genre) continue;
        counts.set(genre, (counts.get(genre) ?? 0) + 1);
        total += 1;
      }
    }
    if (total === 0) return new Map();
    const top = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, CatalogCandidateService.TOP_GENRES);
    return new Map(top.map(([genre, count]) => [genre, count / total]));
  }

  /**
   * Pour chaque genre favori : les 2 mangas biblio au multiplicateur le
   * plus élevé qui portent ce genre (pré-calcul, une passe par genre).
   */
  private buildSourcesByGenre(
    userMangas: UserManga[],
    genres: string[],
  ): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const genre of genres) {
      const sources = userMangas
        .filter((um) => (um.manga?.genres ?? []).includes(genre))
        .sort((a, b) => this.computeMultiplier(b) - this.computeMultiplier(a))
        .slice(0, CatalogCandidateService.SOURCES_PER_CANDIDATE)
        .map((um) => um.manga.mu_id);
      result.set(genre, sources);
    }
    return result;
  }

  /** Miroir de `RecommendationService.computeMultiplier` (voir doc statique). */
  private computeMultiplier(um: UserManga): number {
    const ratingMultiplier = um.user_rating > 0 ? um.user_rating / 5.0 : 1.0;
    const statusMultiplier =
      CatalogCandidateService.STATUS_MULTIPLIER[um.readingStatus] ?? 1.0;
    const ageDays = (Date.now() - um.adding_date.getTime()) / 86_400_000;
    const recencyMultiplier = Math.exp(
      -ageDays / CatalogCandidateService.RECENCY_HALF_LIFE_DAYS,
    );
    return ratingMultiplier * statusMultiplier * recencyMultiplier;
  }
}
