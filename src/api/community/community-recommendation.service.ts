import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { MangasService } from '@/api/mangas/mangas.service';
import { UserMangaRecommendation } from './user-manga-recommendation.entity';
import {
  CommunityRecommendationItemDto,
  CommunityRecommendationsDto,
} from './dto/community-recommendation.dto';

/** Nombre maximal d'œuvres renvoyées pour une fiche. */
export const COMMUNITY_RECOMMENDATIONS_LIMIT = 30;

interface VoteCounts {
  muVotes: number;
  appVotes: number;
  recommendedByMe: boolean;
  /** Poids de la suggestion MU calculée (`category`) — jamais des votes. */
  categoryWeight: number;
}

/**
 * Recommandations « si vous avez aimé A, lisez B » : celles de MangaUpdates
 * (`manga_recommendation`) et celles des utilisateurs Manga Tracker
 * (`user_manga_recommendation`, une ligne par vote), fusionnées à la lecture.
 *
 * Côté MangaUpdates, deux origines :
 * - `manual` : recommandations déposées par ses lecteurs, poids = nombre de
 *   votes → comptées dans `muVotes` ;
 * - `category` : suggestions qu'il calcule (≈ 5 par titre, présentes pour
 *   presque tous les titres) → listées comme « suggérées par MangaUpdates »
 *   (`muSuggested`), **jamais** comptées comme des votes (leur poids croît
 *   avec la popularité du titre source). Sans elles, la liste n'existait que
 *   pour les titres très connus (2,6 % des titres ont des `manual`).
 *
 * Les deux sources restent stockées séparément (le poids MU est réécrit à
 * chaque rafraîchissement de la fiche) ; seul l'affichage additionne.
 */
@Injectable()
export class CommunityRecommendationService {
  constructor(
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    @InjectRepository(MangaRecommendation)
    private readonly muRecoRepository: Repository<MangaRecommendation>,
    @InjectRepository(UserMangaRecommendation)
    private readonly userRecoRepository: Repository<UserMangaRecommendation>,
    private readonly mangasService: MangasService,
  ) {}

  /** Liste fusionnée, triée par total de votes décroissant. */
  async list(
    sourceMuId: number,
    userId: number,
  ): Promise<CommunityRecommendationsDto> {
    const counts = await this.countVotes(sourceMuId, userId);
    const ids = [...counts.keys()]
      .sort((a, b) => compareCounts(a, counts.get(a), b, counts.get(b)))
      .slice(0, COMMUNITY_RECOMMENDATIONS_LIMIT);
    if (ids.length === 0) return { sourceMuId, items: [] };

    const mangas = await this.mangaRepository.find({
      where: { mu_id: In(ids) },
    });
    const byId = new Map(mangas.map((m) => [m.mu_id.toString(), m]));

    const items = ids.map((id) =>
      this.toItem(id, counts.get(id), byId.get(id)),
    );
    return { sourceMuId, items };
  }

  /**
   * Enregistre (idempotent) le vote de [userId] : « qui a aimé [sourceMuId]
   * aimera [targetMuId] ». Une cible pas encore en base (titre trouvé par la
   * recherche) est créée d'après sa fiche MangaUpdates — jamais d'après un
   * texte fourni par le client, qui s'afficherait chez tout le monde.
   */
  async recommend(
    userId: number,
    sourceMuId: number,
    targetMuId: number,
  ): Promise<CommunityRecommendationItemDto> {
    this.assertDistinct(sourceMuId, targetMuId);
    await this.assertSourceExists(sourceMuId);
    await this.ensureTargetExists(targetMuId);

    await this.userRecoRepository
      .createQueryBuilder()
      .insert()
      .into(UserMangaRecommendation)
      .values({
        user: { id: userId },
        source: { mu_id: sourceMuId.toString() },
        recommended: { mu_id: targetMuId.toString() },
      })
      .orIgnore()
      .execute();

    return this.itemFor(sourceMuId, targetMuId, userId);
  }

  /** Retire le vote de [userId] (sans effet s'il n'existait pas). */
  async unrecommend(
    userId: number,
    sourceMuId: number,
    targetMuId: number,
  ): Promise<CommunityRecommendationItemDto> {
    this.assertDistinct(sourceMuId, targetMuId);
    await this.userRecoRepository
      .createQueryBuilder()
      .delete()
      .from(UserMangaRecommendation)
      .where('user_id = :userId', { userId })
      .andWhere('source_mu_id = :source', { source: sourceMuId.toString() })
      .andWhere('recommended_mu_id = :target', {
        target: targetMuId.toString(),
      })
      .execute();
    return this.itemFor(sourceMuId, targetMuId, userId);
  }

  private async itemFor(
    sourceMuId: number,
    targetMuId: number,
    userId: number,
  ): Promise<CommunityRecommendationItemDto> {
    const id = targetMuId.toString();
    const counts = await this.countVotes(sourceMuId, userId, id);
    const manga = await this.mangaRepository.findOne({ where: { mu_id: id } });
    return this.toItem(id, counts.get(id), manga ?? undefined);
  }

  /**
   * Votes par cible pour une source : MU (`manual` = votes, `category` =
   * suggestion) + Manga Tracker (un vote par ligne). [onlyTarget] restreint
   * à une cible.
   */
  private async countVotes(
    sourceMuId: number,
    userId: number,
    onlyTarget?: string,
  ): Promise<Map<string, VoteCounts>> {
    const source = sourceMuId.toString();

    const muQuery = this.muRecoRepository
      .createQueryBuilder('r')
      .select('r.recommended_mu_id::text', 'id')
      .addSelect("MAX(r.weight) FILTER (WHERE r.kind = 'manual')", 'votes')
      .addSelect(
        "MAX(r.weight) FILTER (WHERE r.kind = 'category')",
        'category_weight',
      )
      .where('r.source_mu_id = :source', { source })
      .andWhere("r.kind IN ('manual', 'category')")
      .andWhere('r.weight > 0')
      .andWhere('r.recommended_mu_id <> r.source_mu_id')
      .groupBy('r.recommended_mu_id');
    if (onlyTarget) {
      muQuery.andWhere('r.recommended_mu_id = :target', {
        target: onlyTarget,
      });
    }
    const muRows: Array<{
      id: string;
      votes: string | null;
      category_weight: string | null;
    }> = await muQuery.getRawMany();

    const appQuery = this.userRecoRepository
      .createQueryBuilder('u')
      .select('u.recommended_mu_id::text', 'id')
      .addSelect('COUNT(*)', 'votes')
      .addSelect('BOOL_OR(u.user_id = :userId)', 'mine')
      .where('u.source_mu_id = :source', { source })
      .setParameter('userId', userId)
      .groupBy('u.recommended_mu_id');
    if (onlyTarget) {
      appQuery.andWhere('u.recommended_mu_id = :target', {
        target: onlyTarget,
      });
    }
    const appRows: Array<{ id: string; votes: string; mine: boolean }> =
      await appQuery.getRawMany();

    const counts = new Map<string, VoteCounts>();
    const entry = (id: string): VoteCounts => {
      let c = counts.get(id);
      if (!c) {
        c = {
          muVotes: 0,
          appVotes: 0,
          recommendedByMe: false,
          categoryWeight: 0,
        };
        counts.set(id, c);
      }
      return c;
    };
    for (const row of muRows) {
      const c = entry(row.id);
      c.muVotes = parseInt(row.votes ?? '0', 10) || 0;
      c.categoryWeight = parseInt(row.category_weight ?? '0', 10) || 0;
    }
    for (const row of appRows) {
      const c = entry(row.id);
      c.appVotes = parseInt(row.votes, 10) || 0;
      c.recommendedByMe = row.mine === true;
    }
    if (onlyTarget) entry(onlyTarget);
    return counts;
  }

  private toItem(
    id: string,
    counts: VoteCounts | undefined,
    manga: Manga | undefined,
  ): CommunityRecommendationItemDto {
    const muVotes = counts?.muVotes ?? 0;
    const appVotes = counts?.appVotes ?? 0;
    const rating = manga?.rating != null ? Number(manga.rating) : null;
    return {
      muId: Number(id),
      title: manga?.title ?? `Manga ${id}`,
      year: manga?.year ?? null,
      smallCoverUrl: manga?.small_cover_url ?? null,
      mediumCoverUrl: manga?.medium_cover_url ?? null,
      rating: rating != null && rating > 0 ? rating : null,
      type: manga?.type ?? null,
      muVotes,
      appVotes,
      totalVotes: muVotes + appVotes,
      recommendedByMe: counts?.recommendedByMe ?? false,
      muSuggested: (counts?.categoryWeight ?? 0) > 0,
    };
  }

  private assertDistinct(sourceMuId: number, targetMuId: number): void {
    if (sourceMuId === targetMuId) {
      throw new BadRequestException(
        'Une œuvre ne peut pas se recommander elle-même',
      );
    }
  }

  /**
   * Cible inconnue en base → fiche MangaUpdates (404 si MU ne la connaît pas,
   * 503 s'il est indisponible). Un seul appel, et seulement pour une œuvre
   * absente de la base ; le quota de votes (60 / heure) le borne.
   */
  private async ensureTargetExists(targetMuId: number): Promise<void> {
    const known = await this.mangaRepository.exist({
      where: { mu_id: targetMuId.toString() },
    });
    if (known) return;
    const details = await this.mangasService.getMangaDetails(targetMuId);
    await this.mangaRepository
      .createQueryBuilder()
      .insert()
      .into(Manga)
      .values(Manga.fromMU(details))
      .orIgnore()
      .execute();
  }

  private async assertSourceExists(sourceMuId: number): Promise<void> {
    const exists = await this.mangaRepository.exist({
      where: { mu_id: sourceMuId.toString() },
    });
    if (!exists) {
      throw new NotFoundException(`Manga ${sourceMuId} introuvable`);
    }
  }
}

/**
 * Total de votes décroissant, puis votes Manga Tracker, puis suggestions
 * MangaUpdates (poids décroissant), puis mu_id (ordre stable).
 */
function compareCounts(
  idA: string,
  a: VoteCounts | undefined,
  idB: string,
  b: VoteCounts | undefined,
): number {
  const total = (c?: VoteCounts) => (c?.muVotes ?? 0) + (c?.appVotes ?? 0);
  return (
    total(b) - total(a) ||
    (b?.appVotes ?? 0) - (a?.appVotes ?? 0) ||
    (b?.categoryWeight ?? 0) - (a?.categoryWeight ?? 0) ||
    Number(idA) - Number(idB)
  );
}
