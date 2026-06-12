import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import User from '@/api/user/user.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { UserMangaChapterLog } from '@/api/library/user-manga-chapter-log.entity';
import { UserStatsDto } from './stats.dto';
import { ReadingStatus } from '@/api/library/reading-status.enum';

/**
 * Minutes moyennes par chapitre — heuristique simple pour l'estimation
 * de temps de lecture. Source : enquête utilisateurs scanlation ~15-20
 * pages par chapitre, 12-15 sec par page = ~4 min médian.
 */
const AVERAGE_MINUTES_PER_CHAPTER = 4;

@Injectable()
export class StatsService {
  private readonly logger = new Logger(StatsService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserManga)
    private readonly userMangaRepository: Repository<UserManga>,
    @InjectRepository(UserMangaChapterLog)
    private readonly chapterLogRepository: Repository<UserMangaChapterLog>,
  ) {}

  /**
   * Calcule les statistiques agrégées d'un utilisateur en un seul appel.
   *
   * Pourquoi pas de cache : volume modeste (< 500 mangas/user en pratique),
   * agrégation rapide (< 50 ms). Si ça devient lent, cacher via Redis avec
   * invalidation sur add/remove/update de la biblio.
   */
  async getUserStats(userId: number): Promise<UserStatsDto> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const userMangas = await this.userMangaRepository.find({
      where: { user: { id: userId } },
      relations: ['manga'],
    });

    const mangasByStatus = this.aggregateByStatus(userMangas);
    const totalChaptersRead = userMangas.reduce(
      (sum, um) => sum + (um.user_read_chapters ?? 0),
      0,
    );
    const genreCounts = this.computeGenreCounts(userMangas);
    const lastReadAt = this.findLastReadAt(userMangas);
    const completionRate = this.computeCompletionRate(mangasByStatus);

    // Stats v2 : journal de lecture (historique + activité hebdo). Les deux
    // requêtes sont indépendantes → parallèle.
    const [readingHistory, chaptersPerWeek] = await Promise.all([
      this.fetchReadingHistory(userId),
      this.computeChaptersPerWeek(userId),
    ]);

    this.logger.log(
      `User stats requested for userId=${userId} (${userMangas.length} mangas)`,
    );

    return {
      mangasByStatus,
      totalChaptersRead,
      estimatedReadingTimeMinutes:
        totalChaptersRead * AVERAGE_MINUTES_PER_CHAPTER,
      topGenres: genreCounts.slice(0, 5).map((g) => g.genre),
      lastReadAt: lastReadAt?.toISOString() ?? null,
      completionRate,
      accountCreatedAt:
        user.createdAt?.toISOString() ?? new Date().toISOString(),
      totalMangas: userMangas.length,
      genreCounts,
      readingHistory,
      chaptersPerWeek,
    };
  }

  /**
   * Dernières sessions de lecture (max 20, skips exclus) — Stats v2.
   * Source : journal additif `user_manga_chapter_log` (RETRO-015).
   */
  private async fetchReadingHistory(
    userId: number,
  ): Promise<UserStatsDto['readingHistory']> {
    const logs = await this.chapterLogRepository.find({
      where: { user: { id: userId }, isSkipped: false },
      relations: ['manga'],
      order: { readAt: 'DESC' },
      take: 20,
    });
    return logs.map((log) => ({
      muId: Number(log.manga?.mu_id ?? 0),
      mangaTitle: log.manga?.title ?? '',
      chapterNumber: Number(log.chapterNumber),
      isBonus: log.isBonus,
      readAt: log.readAt.toISOString(),
    }));
  }

  /**
   * Sessions de lecture par semaine (8 dernières semaines, skips exclus),
   * clé = lundi de la semaine (yyyy-MM-dd) — Stats v2, pour le graphique
   * d'activité.
   */
  private async computeChaptersPerWeek(
    userId: number,
  ): Promise<Record<string, number>> {
    const since = new Date();
    since.setDate(since.getDate() - 7 * 8);

    const rows: Array<{ week: string; count: string }> =
      await this.chapterLogRepository
        .createQueryBuilder('log')
        .select("TO_CHAR(DATE_TRUNC('week', log.readAt), 'YYYY-MM-DD')", 'week')
        .addSelect('COUNT(*)', 'count')
        .where('log.user_id = :userId', { userId })
        .andWhere('log.isSkipped = false')
        .andWhere('log.readAt >= :since', { since })
        .groupBy("DATE_TRUNC('week', log.readAt)")
        .orderBy("DATE_TRUNC('week', log.readAt)", 'ASC')
        .getRawMany();

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.week] = parseInt(row.count, 10);
    }
    return result;
  }

  /** Groupe les mangas par statut de lecture (4 statuts standards). */
  private aggregateByStatus(userMangas: UserManga[]): Record<string, number> {
    const buckets: Record<string, number> = {};
    // Initialise tous les statuts à 0 pour stabilité du payload côté front
    for (const status of Object.values(ReadingStatus)) {
      buckets[status] = 0;
    }
    for (const um of userMangas) {
      const status = um.readingStatus ?? ReadingStatus.ReadLater;
      buckets[status] = (buckets[status] ?? 0) + 1;
    }
    return buckets;
  }

  /**
   * Genres de la biblio avec compteurs, triés par fréquence décroissante
   * (un manga "Action,Romance" compte +1 dans chaque). Top 10 — le DTO
   * `topGenres` (compat) prend les 5 premiers, les graphiques v2 tout.
   */
  private computeGenreCounts(
    userMangas: UserManga[],
  ): Array<{ genre: string; count: number }> {
    const counts = new Map<string, number>();
    for (const um of userMangas) {
      const genres = um.manga?.genres ?? [];
      for (const g of genres) {
        if (!g) continue;
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([genre, count]) => ({ genre, count }));
  }

  /** Max(lastUpdated) sur la biblio — null si aucun manga ou aucune date. */
  private findLastReadAt(userMangas: UserManga[]): Date | null {
    let latest: Date | null = null;
    for (const um of userMangas) {
      if (!um.lastUpdated) continue;
      if (!latest || um.lastUpdated > latest) latest = um.lastUpdated;
    }
    return latest;
  }

  /**
   * Taux de complétion : completed / (reading + completed + caughtUp).
   * readLater exclu (= wishlist, pas un manga "engagé"). Retourne 0 si
   * dénominateur nul.
   */
  private computeCompletionRate(
    mangasByStatus: Record<string, number>,
  ): number {
    const completed = mangasByStatus[ReadingStatus.Completed] ?? 0;
    const engaged =
      (mangasByStatus[ReadingStatus.Reading] ?? 0) +
      (mangasByStatus[ReadingStatus.Completed] ?? 0) +
      (mangasByStatus[ReadingStatus.CaughtUp] ?? 0);
    if (engaged === 0) return 0;
    return Number((completed / engaged).toFixed(3));
  }
}
