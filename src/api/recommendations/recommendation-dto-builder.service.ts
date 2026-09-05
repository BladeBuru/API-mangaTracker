import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { MangasService } from '@/api/mangas/mangas.service';
import { MangaQuickViewDto } from '@/api/mangas/dto/manga-quick-view.dto';
import { hydrateIncompleteDtosInBackground } from '@/api/mangas/manga-completeness.util';
import { ScoredEntry } from './scored-entry.interface';
import {
  interleaveByTypeMix,
  isEmptyTypeProfile,
  TypeProfile,
} from './type-profile';

/** Entrée du pool triée, avec son type (quand connu) pour la sélection. */
interface RankedEntry {
  mu_id: string;
  score: number;
  sources: Map<string, number>;
  type?: string | null;
}

export interface DtoBuildOptions {
  limit: number;
  offset: number;
  genreFilter?: string;
  /** Profil de type de la bibliothèque (vide = pas de rééquilibrage). */
  profile: TypeProfile;
}

/**
 * Transforme le pool scoré (`Map<mu_id, ScoredEntry>`) de la liste plate
 * `GET /recommendations` en cartes `MangaQuickViewDto` : tri par score,
 * **sélection au prorata du profil de type**, filtre genre optionnel,
 * pagination, explicabilité (`recommendedBecauseOf`), enrichissement
 * communautaire et hydratation à la demande des stubs.
 *
 * Extrait de `RecommendationService` (2026-09-05, limite de 600 lignes).
 *
 * ## Type de publication
 *
 * Le pool est réordonné par `interleaveByTypeMix` AVANT la pagination : un
 * lecteur à 80 % manhwa voit ≈ 80 % de manhwa sur chaque page, et la page 2
 * prolonge la page 1 sans trou ni doublon (ordre global déterministe, mis en
 * cache par `RecoCacheService`). Sans profil (bibliothèque non typée), le
 * comportement historique — tri par score pur — est conservé à l'identique.
 */
@Injectable()
export class RecommendationDtoBuilderService {
  private readonly logger = new Logger(RecommendationDtoBuilderService.name);

  constructor(
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    private readonly mangasService: MangasService,
  ) {}

  async build(
    scoreMap: Map<string, ScoredEntry>,
    options: DtoBuildOptions,
  ): Promise<MangaQuickViewDto[]> {
    const { limit, offset, genreFilter, profile } = options;
    let sorted: RankedEntry[] = Array.from(scoreMap.entries())
      .map(([mu_id, entry]) => ({
        mu_id,
        score: entry.score,
        sources: entry.sources,
      }))
      .sort((a, b) => b.score - a.score);
    if (sorted.length === 0) return [];

    const mangaMap = new Map<string, Manga>();
    const needsWholePool = Boolean(genreFilter) || !isEmptyTypeProfile(profile);
    if (needsWholePool) {
      // Filtre genre et/ou prorata de type : il faut connaître TOUS les
      // candidats avant de paginer, sinon on perd des titres pertinents
      // au-delà de l'offset (genre) ou on ne peut pas rééquilibrer (type).
      const allMangas = await this.mangaRepository.find({
        where: { mu_id: In(sorted.map((s) => s.mu_id)) },
      });
      for (const m of allMangas) mangaMap.set(m.mu_id, m);
    }

    if (genreFilter) {
      const normalized = genreFilter.trim().toLowerCase();
      sorted = sorted.filter((s) => {
        const m = mangaMap.get(s.mu_id);
        if (!m?.genres) return false;
        return m.genres.some((g) => g.toLowerCase() === normalized);
      });
      if (sorted.length === 0) return [];
    }

    if (!isEmptyTypeProfile(profile)) {
      sorted = interleaveByTypeMix(
        sorted,
        (s) => mangaMap.get(s.mu_id)?.type,
        profile,
      );
    }

    sorted = sorted.slice(offset, offset + limit);
    if (!needsWholePool) {
      // Sans filtre ni profil : ne fetcher que la page demandée.
      const mangas = await this.mangaRepository.find({
        where: { mu_id: In(sorted.map((s) => s.mu_id)) },
      });
      for (const m of mangas) mangaMap.set(m.mu_id, m);
    }

    const sourceTitleMap = await this.loadSourceTitles(sorted);

    // Enrichissement note communautaire (Bayesian aggregation MU + locaux)
    const finalMuIds = sorted.map((s) => s.mu_id);
    const muRatings = new Map<string, number>();
    for (const id of finalMuIds) {
      const m = mangaMap.get(id);
      if (m) muRatings.set(id, Number(m.rating) || 0);
    }
    const communityRatings = await this.mangasService.getCommunityRatings(
      finalMuIds,
      muRatings,
    );

    const dtos = sorted
      .map((scored) => {
        const manga = mangaMap.get(scored.mu_id);
        if (!manga) return null;
        // Stubs : year/rating/cover peuvent être null tant que getMangaDetails
        // n'a pas été appelé — repli 0 / '' (contrat DTO inchangé).
        const dto = MangaQuickViewDto.fromCatalog(manga);
        const topSources = Array.from(scored.sources.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([muId]) => sourceTitleMap.get(muId))
          .filter((t): t is string => Boolean(t));
        if (topSources.length > 0) dto.recommendedBecauseOf = topSources;
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

    // Complétude des cartes (fix 2026-08-28) : les stubs créés par
    // `saveRecommendations` n'ont ni année ni note (l'endpoint MU
    // « recommendations » ne les renvoie pas). Hydratation en tâche de fond,
    // au plus 8 par requête, jamais bloquante, jamais fatale.
    // ⚠️ `RecoCacheService` (TTL 1 h) : gain visible au prochain miss.
    hydrateIncompleteDtosInBackground(
      dtos,
      (id) => this.mangasService.getMangaDetails(id),
      this.logger,
    );

    return dtos;
  }

  /** Titres des mangas sources (`recommendedBecauseOf`) — 1 requête. */
  private async loadSourceTitles(
    entries: RankedEntry[],
  ): Promise<Map<string, string>> {
    const sourceMuIds = Array.from(
      new Set(entries.flatMap((s) => Array.from(s.sources.keys()))),
    );
    if (sourceMuIds.length === 0) return new Map();
    const sourceMangas = await this.mangaRepository.find({
      where: { mu_id: In(sourceMuIds) },
    });
    return new Map(sourceMangas.map((m) => [m.mu_id, m.title]));
  }
}
