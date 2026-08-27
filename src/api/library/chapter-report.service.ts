import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import User from '@/api/user/user.entity';
import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { MangaChapterReport } from './manga-chapter-report.entity';
import { ReportChaptersResultDto } from './dto/report-chapters.dto';

/**
 * Nombre minimum de rapporteurs distincts concordants pour consolider le
 * total officiel (`manga.total_chapters`).
 */
export const MIN_REPORTERS = 2;

/**
 * Delta maximum accepté entre le total officiel et un total signalé —
 * garde-fou anti-typo / anti-abus (collusion bornée).
 */
export const MAX_REPORT_DELTA = 200;

/**
 * Service dédié du signalement « plus de chapitres » (Chantier A).
 *
 * Séparé de `LibraryService` (déjà ~350 lignes) : gère le cycle de vie des
 * `manga_chapter_report` — upsert par user, calcul du total effectif,
 * purge lazy quand le total officiel rattrape, consolidation communautaire.
 */
@Injectable()
export class ChapterReportService {
  private readonly logger = new Logger(ChapterReportService.name);

  constructor(
    @InjectRepository(MangaChapterReport)
    private readonly reportRepository: Repository<MangaChapterReport>,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    @InjectRepository(UserManga)
    private readonly userMangaRepository: Repository<UserManga>,
  ) {}

  /**
   * Enregistre (upsert) le signalement d'un user, puis tente la
   * consolidation communautaire.
   *
   * Gate anti-abus : le manga doit être dans la bibliothèque de l'user
   * (404 sinon). Le total signalé doit être strictement supérieur au total
   * officiel (400) et borné à `total + MAX_REPORT_DELTA` (400).
   */
  async reportMoreChapters(
    userId: number,
    muId: number,
    reportedTotal: number,
  ): Promise<ReportChaptersResultDto> {
    const userManga = await this.userMangaRepository.findOne({
      where: { user: { id: userId }, manga: { mu_id: muId.toString() } },
    });
    if (!userManga) {
      throw new NotFoundException(
        `Nothing found in user's library for userId: ${userId} and muId: ${muId} — the manga must be in the library to report chapters`,
      );
    }

    const manga = await this.mangaRepository.findOneBy({
      mu_id: muId.toString(),
    });
    if (!manga) {
      throw new NotFoundException(`Manga with mu_id ${muId} not found`);
    }

    if (reportedTotal <= manga.total_chapters) {
      throw new BadRequestException(
        `Reported total (${reportedTotal}) must be strictly greater than the known total (${manga.total_chapters})`,
      );
    }
    if (reportedTotal > manga.total_chapters + MAX_REPORT_DELTA) {
      throw new BadRequestException(
        `Reported total (${reportedTotal}) exceeds the maximum accepted value (${
          manga.total_chapters + MAX_REPORT_DELTA
        } = known total + ${MAX_REPORT_DELTA})`,
      );
    }

    // Upsert : un report actif par (user, manga) — le nouveau écrase l'ancien.
    await this.reportRepository
      .createQueryBuilder()
      .insert()
      .into(MangaChapterReport)
      .values({
        user: { id: userId } as User,
        manga,
        reported_total: reportedTotal,
      })
      .orUpdate(['reported_total', 'updated_at'], ['user_id', 'manga_id'])
      .execute();

    const consolidated = await this.consolidate(muId);

    // Si consolidé, le total officiel a pu bouger — on relit pour renvoyer
    // le total effectif exact au client.
    const freshManga = consolidated
      ? await this.mangaRepository.findOneBy({ mu_id: muId.toString() })
      : manga;
    const officialTotal = freshManga?.total_chapters ?? manga.total_chapters;

    return {
      reportedTotal,
      effectiveTotalChapters: Math.max(officialTotal, reportedTotal),
      consolidated,
    };
  }

  /**
   * Total effectif pour un user : `max(total officiel, report user)`.
   *
   * Purge lazy : si le total officiel a rattrapé (ou dépassé) le report,
   * la ligne ne sert plus à rien → DELETE et retour du total officiel.
   */
  async getEffectiveTotal(
    userId: number,
    muId: number,
    mangaTotal: number,
  ): Promise<number> {
    const report = await this.reportRepository.findOne({
      where: { user: { id: userId }, manga: { mu_id: muId.toString() } },
    });
    if (!report) return mangaTotal;

    if (report.reported_total <= mangaTotal) {
      await this.reportRepository.delete(report.id);
      return mangaTotal;
    }
    return report.reported_total;
  }

  /**
   * Reports actifs d'un user pour un lot de mangas — 1 seule requête IN
   * (pas de N+1 pour `GET /library/all`).
   *
   * @returns Map `mu_id` (string) → reported_total.
   */
  async getUserReportsByMangaIds(
    userId: number,
    muIds: number[],
  ): Promise<Map<string, number>> {
    if (muIds.length === 0) return new Map();

    const rows: Array<{ manga_id: string; reported_total: string }> =
      await this.reportRepository
        .createQueryBuilder('r')
        .select('r.manga_id::text', 'manga_id')
        .addSelect('r.reported_total', 'reported_total')
        .where('r.user_id = :userId', { userId })
        .andWhere('r.manga_id IN (:...ids)', {
          ids: muIds.map((id) => id.toString()),
        })
        .getRawMany();

    return new Map(
      rows.map((r) => [String(r.manga_id), Number(r.reported_total)]),
    );
  }

  /**
   * Consolidation communautaire : si ≥ MIN_REPORTERS users distincts ont
   * signalé un total > total officiel, on bumpe `manga.total_chapters` au
   * MIN des totaux signalés concordants (conservateur), sans toucher
   * `completed`, puis on purge les reports couverts (≤ nouveau total).
   *
   * Écriture GREATEST : monotone croissante — convergente face au refresh
   * 6h de `checkManga` (pas de lock nécessaire).
   *
   * @returns true si une consolidation a eu lieu.
   */
  async consolidate(muId: number): Promise<boolean> {
    const manga = await this.mangaRepository.findOneBy({
      mu_id: muId.toString(),
    });
    if (!manga) return false;

    const row: { reporters: string; min_reported: string } | undefined =
      await this.reportRepository
        .createQueryBuilder('r')
        .select('COUNT(DISTINCT r.user_id)', 'reporters')
        .addSelect('MIN(r.reported_total)', 'min_reported')
        .where('r.manga_id = :muId', { muId: muId.toString() })
        .andWhere('r.reported_total > :total', {
          total: manga.total_chapters,
        })
        .getRawOne();

    const reporters = Number(row?.reporters ?? 0);
    if (reporters < MIN_REPORTERS) return false;

    const newTotal = Math.max(
      manga.total_chapters,
      Number(row.min_reported) || 0,
    );

    await this.mangaRepository
      .createQueryBuilder()
      .update(Manga)
      .set({
        total_chapters: () => 'GREATEST(total_chapters, :newTotal)',
      })
      .setParameter('newTotal', newTotal)
      .where('mu_id = :muId', { muId: muId.toString() })
      .execute();

    await this.reportRepository
      .createQueryBuilder()
      .delete()
      .from(MangaChapterReport)
      .where('manga_id = :muId', { muId: muId.toString() })
      .andWhere('reported_total <= :newTotal', { newTotal })
      .execute();

    this.logger.log(
      `Consolidated total_chapters to ${newTotal} for manga ${muId} (${reporters} concordant reporters)`,
    );
    return true;
  }
}
