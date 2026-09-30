import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { aggregateRating } from '@/api/mangas/rating-aggregator';
import { RatingSummaryDto } from './dto/community-recommendation.dto';

/**
 * Synthèse des notes d'une œuvre, lue en base uniquement (aucun appel
 * MangaUpdates) : l'app la redemande juste après qu'un utilisateur a noté,
 * pour que la note globale et le total de votes reflètent son vote.
 */
@Injectable()
export class RatingSummaryService {
  constructor(
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    @InjectRepository(UserManga)
    private readonly userMangaRepository: Repository<UserManga>,
  ) {}

  async getSummary(muId: number): Promise<RatingSummaryDto> {
    const manga = await this.mangaRepository.findOne({
      where: { mu_id: muId.toString() },
      select: ['id', 'mu_id', 'rating', 'rating_votes'],
    });
    if (!manga) throw new NotFoundException(`Manga ${muId} introuvable`);

    const local: { avg: string | null; count: string } | undefined =
      await this.userMangaRepository
        .createQueryBuilder('um')
        .select('AVG(um.user_rating)', 'avg')
        .addSelect('COUNT(*)', 'count')
        .where('um.manga_id = :muId', { muId: muId.toString() })
        .andWhere('um.user_rating > 0')
        .getRawOne();

    const localCount = parseInt(local?.count ?? '0', 10) || 0;
    const localAvg = local?.avg != null ? parseFloat(local.avg) : null;
    const muRating = manga.rating != null ? Number(manga.rating) : 0;

    const merged = aggregateRating(
      muRating,
      localAvg,
      localCount,
      undefined,
      manga.rating_votes,
    );
    return {
      mu_rating: muRating > 0 ? muRating : null,
      mu_rating_votes: merged.muRatingVotes,
      community_rating:
        merged.communityRating != null
          ? Math.round(merged.communityRating * 100) / 100
          : null,
      community_rating_count: merged.communityRatingCount,
      aggregated_rating:
        merged.aggregatedRating > 0 ? merged.aggregatedRating : null,
      total_rating_votes: merged.totalRatingVotes,
    };
  }
}
