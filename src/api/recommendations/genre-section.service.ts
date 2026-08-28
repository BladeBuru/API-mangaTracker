import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { MangasService } from '@/api/mangas/mangas.service';
import { MangaQuickViewDto } from '@/api/mangas/dto/manga-quick-view.dto';
import { CommunityRating } from '@/api/mangas/rating-aggregator';
import { NSFW_GENRES } from '@/api/mangas/constants';
import { hydrateIncompleteDtosInBackground } from '@/api/mangas/manga-completeness.util';
import { ScoredEntry } from './scored-entry.interface';

/** Entrée du pool triée par score, prête à être affectée à une section. */
interface PoolEntry {
  mu_id: string;
  score: number;
  sources: Map<string, number>;
}

/**
 * Construit les sections « Recommandations par genre » de la home
 * (`GET /recommendations/by-genre`) à partir du pool scoré calculé par
 * `RecommendationService.computeScoreMap`.
 *
 * **Fix 2026-08-25** (bug prod « mêmes titres dans toutes les sections ») :
 * l'ancienne implémentation poussait chaque manga dans TOUTES les sections
 * correspondant à ses genres, sans dédup ni complément — avec un pool maigre
 * (~5 titres en prod), toutes les sections affichaient les mêmes titres,
 * certains en triple. Désormais :
 *
 *  1. **Dédup par mu_id** : le pool est un `Map` (unicité structurelle) et
 *     l'affectation passe par un `Set` global `assigned` + un `Set` défensif
 *     par section (robuste aux genres dupliqués type `['Action', 'Action ']`).
 *  2. **Exclusivité inter-sections** : un manga n'apparaît que dans UNE
 *     section — celle de son genre le mieux classé (ordre des top genres de
 *     l'utilisateur, cf. `rankGenres`) ; les sections suivantes l'excluent.
 *     S'il ne rentre pas dans sa meilleure section (déjà pleine), il reste
 *     candidat pour ses genres suivants.
 *  3. **Complément catalogue** : une section sous `perGenre` est complétée
 *     par le catalogue local (rating ≥ 7, NSFW exclus, hors biblio, hors
 *     titres déjà affichés) avec des titres portant CE genre — au plus une
 *     requête par section déficitaire, jamais de N+1.
 *
 * Contrat de réponse inchangé : `Record<genre, MangaQuickViewDto[]>`.
 */
@Injectable()
export class GenreSectionService {
  private readonly logger = new Logger(GenreSectionService.name);

  /**
   * Note MU minimale d'un titre de complément catalogue — aligné sur
   * `CatalogCandidateService.RATING_FLOOR`.
   */
  private static readonly CATALOG_RATING_FLOOR = 7.0;

  /**
   * Genres exclus des sections : union de `NSFW_GENRES` (liste utilisée par
   * les requêtes catalogue) et de l'ancienne liste inline du service — on
   * conserve la couverture la plus large des deux pour ne rien laisser
   * réapparaître.
   */
  private static readonly EXCLUDED_SECTION_GENRES = new Set([
    ...NSFW_GENRES,
    'Mature',
    'Yaoi',
    'Yuri',
    'Ecchi',
  ]);

  constructor(
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    private readonly mangasService: MangasService,
  ) {}

  /**
   * Construit la map `genre → MangaQuickViewDto[]` de la home segmentée.
   *
   * Requêtes émises : 1 (mangas du pool) + ≤ 1 par section déficitaire
   * (complément catalogue) + 1 (titres sources) + l'agrégation communautaire
   * déléguée à `MangasService`.
   */
  async buildSections(
    scoreMap: Map<string, ScoredEntry>,
    userMangas: UserManga[],
    topGenres: number,
    perGenre: number,
    excludedMuIds: Set<string>,
  ): Promise<Record<string, MangaQuickViewDto[]>> {
    if (scoreMap.size === 0) return {};

    // Pool trié par score desc — la dédup par mu_id est structurelle (Map).
    const pool: PoolEntry[] = Array.from(scoreMap.entries())
      .map(([mu_id, entry]) => ({
        mu_id,
        score: entry.score,
        sources: entry.sources,
      }))
      .sort((a, b) => b.score - a.score);

    const mangas = await this.mangaRepository.find({
      where: { mu_id: In(pool.map((p) => p.mu_id)) },
    });
    const mangaMap = new Map(mangas.map((m) => [m.mu_id, m]));

    const rankedGenres = this.rankGenres(userMangas, pool, mangaMap, topGenres);
    if (rankedGenres.length === 0) return {};

    // Affectation exclusive : un mu_id n'appartient qu'à UNE section — la
    // première (dans l'ordre des genres classés) dont il porte le genre.
    const assigned = new Set<string>();
    const sections = new Map<string, PoolEntry[]>();
    for (const genre of rankedGenres) {
      const list: PoolEntry[] = [];
      for (const entry of pool) {
        if (list.length >= perGenre) break;
        if (assigned.has(entry.mu_id)) continue;
        // Défense en profondeur : le pool vient d'un scoreMap déjà filtré,
        // mais on ne veut dépendre d'aucune garantie amont pour un rejet.
        if (excludedMuIds.has(entry.mu_id)) continue;
        if (!this.normalizedGenres(mangaMap.get(entry.mu_id)).has(genre)) {
          continue;
        }
        list.push(entry);
        assigned.add(entry.mu_id);
      }
      sections.set(genre, list);
    }

    // Complément catalogue des sections déficitaires. Exclusions cumulées :
    // `excludedMuIds` (biblio ∪ titres écartés « pas intéressé / déjà vu »,
    // calculé par `RecommendationService.buildExclusionSet`) + tout titre
    // déjà affiché (pool affecté et compléments amont).
    //
    // ⚠️ Ce set est fourni par l'appelant et JAMAIS reconstruit ici : le
    // recalculer depuis `userMangas` ne donnerait que la bibliothèque et
    // laisserait les compléments catalogue réintroduire un titre rejeté.
    const excluded = new Set<string>([...excludedMuIds, ...assigned]);
    const fillers = new Map<string, Manga[]>();
    for (const [genre, list] of sections) {
      const deficit = perGenre - list.length;
      if (deficit <= 0) continue;
      const found = await this.findCatalogFillers(genre, excluded, deficit);
      if (found.length === 0) continue;
      fillers.set(genre, found);
      for (const manga of found) {
        excluded.add(manga.mu_id);
        if (!mangaMap.has(manga.mu_id)) mangaMap.set(manga.mu_id, manga);
      }
    }

    return this.buildDtos(sections, fillers, mangaMap);
  }

  /**
   * Classe les genres candidats aux sections — « ordre des top genres de
   * l'utilisateur » :
   *  1. genres favoris de la bibliothèque (occurrences décroissantes,
   *     pattern `CatalogCandidateService.computeGenreShares`) ;
   *  2. puis, s'il reste des slots (< `topGenres`), les genres les plus
   *     représentés dans le pool (fallback — ancien comportement, utile
   *     quand la biblio ne contient que des stubs sans genres).
   * Égalités départagées alphabétiquement pour un ordre déterministe.
   */
  private rankGenres(
    userMangas: UserManga[],
    pool: PoolEntry[],
    mangaMap: Map<string, Manga>,
    topGenres: number,
  ): string[] {
    const libCounts = this.countGenres(userMangas.map((um) => um.manga));
    const poolCounts = this.countGenres(pool.map((p) => mangaMap.get(p.mu_id)));

    const byCountDesc = (a: [string, number], b: [string, number]): number =>
      b[1] - a[1] || a[0].localeCompare(b[0]);

    const fromLibrary = Array.from(libCounts.entries())
      .sort(byCountDesc)
      .map(([genre]) => genre);
    const fromPool = Array.from(poolCounts.entries())
      .filter(([genre]) => !libCounts.has(genre))
      .sort(byCountDesc)
      .map(([genre]) => genre);

    return [...fromLibrary, ...fromPool].slice(0, topGenres);
  }

  /** Occurrences de chaque genre éligible dans une liste de mangas. */
  private countGenres(mangas: Array<Manga | undefined>): Map<string, number> {
    const counts = new Map<string, number>();
    for (const manga of mangas) {
      for (const genre of this.normalizedGenres(manga)) {
        counts.set(genre, (counts.get(genre) ?? 0) + 1);
      }
    }
    return counts;
  }

  /**
   * Genres d'un manga : trimés, dédupliqués (Set), genres NSFW/exclus
   * retirés. Les stubs sans genres retournent un Set vide (ils restent donc
   * hors sections, comme avant le fix).
   */
  private normalizedGenres(manga: Manga | undefined): Set<string> {
    const result = new Set<string>();
    for (const raw of manga?.genres ?? []) {
      const genre = raw?.trim();
      if (!genre) continue;
      if (GenreSectionService.EXCLUDED_SECTION_GENRES.has(genre)) continue;
      result.add(genre);
    }
    return result;
  }

  /**
   * Titres du catalogue local portant `genre` pour compléter une section
   * (pattern `CatalogCandidateService.findCandidates`) : rating ≥ 7, aucun
   * genre NSFW, hors exclusions (biblio + déjà affichés), tri rating DESC.
   * Une seule requête par section déficitaire — jamais de N+1.
   *
   * Résilient : une erreur (catalogue indisponible) est loggée et la section
   * reste servie avec ses titres du pool.
   */
  private async findCatalogFillers(
    genre: string,
    excludeMuIds: Set<string>,
    limit: number,
  ): Promise<Manga[]> {
    try {
      const qb = this.mangaRepository
        .createQueryBuilder('m')
        .where('m.genres IS NOT NULL')
        .andWhere('m.genres::jsonb ?| ARRAY[:...sectionGenres]', {
          sectionGenres: [genre],
        })
        .andWhere('NOT (m.genres::jsonb ?| ARRAY[:...nsfwGenres])', {
          nsfwGenres: NSFW_GENRES,
        })
        .andWhere('m.rating >= :ratingFloor', {
          ratingFloor: GenreSectionService.CATALOG_RATING_FLOOR,
        });
      if (excludeMuIds.size > 0) {
        qb.andWhere('m.mu_id NOT IN (:...excludeMuIds)', {
          excludeMuIds: Array.from(excludeMuIds),
        });
      }
      return await qb.orderBy('m.rating', 'DESC').limit(limit).getMany();
    } catch (err) {
      this.logger.warn(
        `Complément catalogue indisponible pour "${genre}": ${err}`,
      );
      return [];
    }
  }

  /**
   * Assemble les DTOs : titres du pool (score desc) puis compléments
   * catalogue (rating desc), avec dédup défensive par section. Les sections
   * restées vides sont omises de la réponse (le front n'affiche pas de
   * section sans contenu).
   */
  private async buildDtos(
    sections: Map<string, PoolEntry[]>,
    fillers: Map<string, Manga[]>,
    mangaMap: Map<string, Manga>,
  ): Promise<Record<string, MangaQuickViewDto[]>> {
    // Titres des mangas sources (`recommendedBecauseOf`) — 1 requête.
    const sourceMuIds = new Set<string>();
    for (const list of sections.values()) {
      for (const entry of list) {
        for (const id of entry.sources.keys()) sourceMuIds.add(id);
      }
    }
    const sourceMangas =
      sourceMuIds.size > 0
        ? await this.mangaRepository.find({
            where: { mu_id: In(Array.from(sourceMuIds)) },
          })
        : [];
    const sourceTitleMap = new Map(sourceMangas.map((m) => [m.mu_id, m.title]));

    // Enrichissement communautaire — 1 appel pour tous les titres affichés.
    const displayedIds: string[] = [];
    for (const list of sections.values()) {
      for (const entry of list) displayedIds.push(entry.mu_id);
    }
    for (const list of fillers.values()) {
      for (const manga of list) displayedIds.push(manga.mu_id);
    }
    const muRatings = new Map<string, number>();
    for (const id of displayedIds) {
      const manga = mangaMap.get(id);
      if (manga) muRatings.set(id, Number(manga.rating) || 0);
    }
    const community = await this.mangasService.getCommunityRatings(
      displayedIds,
      muRatings,
    );

    const result: Record<string, MangaQuickViewDto[]> = {};
    for (const [genre, list] of sections) {
      const seen = new Set<string>();
      const dtos: MangaQuickViewDto[] = [];
      for (const entry of list) {
        if (seen.has(entry.mu_id)) continue;
        const manga = mangaMap.get(entry.mu_id);
        if (!manga) continue;
        seen.add(entry.mu_id);
        dtos.push(
          this.toDto(manga, community, this.topSources(entry, sourceTitleMap)),
        );
      }
      for (const manga of fillers.get(genre) ?? []) {
        if (seen.has(manga.mu_id)) continue;
        seen.add(manga.mu_id);
        dtos.push(this.toDto(manga, community, []));
      }
      if (dtos.length > 0) result[genre] = dtos;
    }

    // Complétude des cartes (fix 2026-08-28) : mêmes stubs sans année ni note
    // que sur la home non segmentée. Hydratation en tâche de fond, plafonnée
    // à 8 mangas par requête toutes sections confondues, jamais bloquante et
    // jamais fatale (cf. le helper).
    // ⚠️ `RecoCacheService` (TTL 1 h) : gain visible au prochain miss de cache.
    const displayedDtos: MangaQuickViewDto[] = [];
    for (const genreDtos of Object.values(result)) {
      displayedDtos.push(...genreDtos);
    }
    hydrateIncompleteDtosInBackground(
      displayedDtos,
      (id) => this.mangasService.getMangaDetails(id),
      this.logger,
    );

    return result;
  }

  /** Top 3 des mangas sources par contribution (explicabilité). */
  private topSources(
    entry: PoolEntry,
    sourceTitleMap: Map<string, string>,
  ): string[] {
    return Array.from(entry.sources.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => sourceTitleMap.get(id))
      .filter((t): t is string => Boolean(t));
  }

  /**
   * Mapping entité → DTO (null-safe sur les stubs : covers/year/rating à
   * `''`/`0` tant que `getMangaDetails` n'a pas tourné).
   */
  private toDto(
    manga: Manga,
    community: Map<string, CommunityRating>,
    recommendedBecauseOf: string[],
  ): MangaQuickViewDto {
    const dto = new MangaQuickViewDto();
    dto.muId = Number(manga.mu_id);
    dto.title = manga.title;
    dto.year = manga.year ?? 0;
    dto.mediumCoverUrl = manga.medium_cover_url ?? '';
    dto.largeCoverUrl = manga.medium_cover_url ?? '';
    dto.rating = manga.rating !== null ? Number(manga.rating) : 0;
    if (recommendedBecauseOf.length > 0) {
      dto.recommendedBecauseOf = recommendedBecauseOf;
    }
    const c = community.get(manga.mu_id);
    if (c) {
      if (c.communityRating !== null) dto.communityRating = c.communityRating;
      dto.communityRatingCount = c.communityRatingCount;
      dto.aggregatedRating = c.aggregatedRating;
    }
    return dto;
  }
}
