import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { UserMangaChapterLog } from './user-manga-chapter-log.entity';
import { Manga } from '@/api/mangas/manga.entity';
import User from '@/api/user/user.entity';
import { ChapterLogEntryDto, RecordChapterLogDto } from './dto/chapter-log.dto';

/**
 * Cap de lignes journalisées par backfill (B-3) : au-delà, seuls les
 * BACKFILL_CAP derniers chapitres sont loggés (le chiffre principal vient
 * du pointeur `user_read_chapters` → rien de perdu sur la progression).
 */
export const BACKFILL_CAP = 500;

/**
 * Fenêtre d'idempotence du log (B-5), en minutes : une ligne de lecture
 * (user, manga, chapitre, non-skippée) plus récente que cette fenêtre
 * n'est pas dupliquée (double-écriture reader + updateChapter).
 */
export const DEDUP_WINDOW_MINUTES = 10;

/** Taille de chunk pour les INSERT multi-rows du backfill. */
const BACKFILL_INSERT_CHUNK_SIZE = 100;

/**
 * Service du log additif de chapitres (Phase 5).
 *
 * Sépare la mécanique de tracking détaillé (replays, skips, bonus, scroll
 * position) du pointeur de progression principal (`user_manga.user_read_chapters`).
 * Le pointeur reste géré par `LibraryService.updateChapter` ; ce service
 * enrichit avec un log historique.
 */
@Injectable()
export class ChapterLogService {
  private readonly logger = new Logger(ChapterLogService.name);

  constructor(
    @InjectRepository(UserMangaChapterLog)
    private readonly logRepo: Repository<UserMangaChapterLog>,
    @InjectRepository(Manga)
    private readonly mangaRepo: Repository<Manga>,
  ) {}

  /**
   * Enregistre une session de lecture. Insertion pure — N appels pour un
   * même chapitre = N lignes (replays). Le caller décide quand insérer
   * (typiquement à la fin du chapitre, ou à intervalles réguliers pour
   * sauvegarder le scroll en cours).
   */
  async recordChapterRead(
    userId: number,
    muId: number,
    body: RecordChapterLogDto,
  ): Promise<ChapterLogEntryDto> {
    const manga = await this.mangaRepo.findOneBy({ mu_id: muId.toString() });
    if (!manga) {
      throw new NotFoundException(`Manga with mu_id ${muId} not found`);
    }

    // B-5 : fenêtre d'idempotence — si la même lecture (user, manga,
    // chapitre, non-skippée) a déjà été journalisée il y a moins de
    // DEDUP_WINDOW_MINUTES (double-écriture reader + backfill updateChapter),
    // on réutilise la ligne existante. Les replays plus vieux que la
    // fenêtre restent journalisés normalement.
    const recent = await this.findRecentRead(userId, muId, body.chapterNumber);
    if (recent) {
      return ChapterLogEntryDto.fromEntity(recent);
    }

    const log = new UserMangaChapterLog();
    log.user = { id: userId } as User;
    log.manga = manga;
    log.chapterNumber = body.chapterNumber;
    log.isBonus = body.isBonus ?? false;
    log.isSkipped = false;
    log.scrollPosition = body.scrollPosition ?? null;

    const saved = await this.logRepo.save(log);
    return ChapterLogEntryDto.fromEntity(saved);
  }

  /**
   * Historique des sessions de lecture d'un manga pour un user. Trié par
   * date décroissante (le plus récent en premier).
   */
  async listForManga(
    userId: number,
    muId: number,
  ): Promise<ChapterLogEntryDto[]> {
    const rows = await this.logRepo.find({
      where: {
        user: { id: userId },
        manga: { mu_id: muId.toString() },
      },
      order: { readAt: 'DESC' },
      take: 500, // Garde-fou : 500 entrées max par fetch (pagination future si besoin).
    });
    return rows.map((r) => ChapterLogEntryDto.fromEntity(r));
  }

  /**
   * Toggle "ce chapitre est skippé" pour un user.
   *
   * Implémentation : si une entrée `isSkipped` existe déjà pour ce
   * `(user, manga, chapter)`, on la met à jour (toggle). Sinon on crée
   * une nouvelle ligne. Permet à l'UI de bascule rapidement sans cumuler
   * les rows skip/unskip.
   */
  async toggleSkip(
    userId: number,
    muId: number,
    chapterNumber: number,
    skipped: boolean,
  ): Promise<ChapterLogEntryDto> {
    const manga = await this.mangaRepo.findOneBy({ mu_id: muId.toString() });
    if (!manga) {
      throw new NotFoundException(`Manga with mu_id ${muId} not found`);
    }

    let existing = await this.logRepo
      .createQueryBuilder('log')
      .where('log.user_id = :userId', { userId })
      .andWhere('log.manga_id = :mangaId', { mangaId: manga.mu_id })
      .andWhere('log.chapterNumber = :chapterNumber', { chapterNumber })
      .andWhere('log.isSkipped IS NOT NULL') // marker pour repérer une ligne dédiée au skip
      .getOne();

    if (!existing) {
      existing = new UserMangaChapterLog();
      existing.user = { id: userId } as User;
      existing.manga = manga;
      existing.chapterNumber = chapterNumber;
    }
    existing.isSkipped = skipped;
    const saved = await this.logRepo.save(existing);
    return ChapterLogEntryDto.fromEntity(saved);
  }

  /**
   * Backfill du journal pour le chemin manuel (Chantier B — B-2) : quand le
   * pointeur `user_read_chapters` avance de `fromExclusive` à `toInclusive`,
   * journalise les chapitres `from+1..to` en UN INSERT multi-rows (chunks
   * de {@link BACKFILL_INSERT_CHUNK_SIZE}), `isBonus=false` (B-6),
   * `isSkipped=false`, `scrollPosition=null`.
   *
   * - Cap B-3 : si le delta dépasse {@link BACKFILL_CAP}, seuls les
   *   BACKFILL_CAP DERNIERS chapitres sont journalisés (+ warn).
   * - Dédup B-5 (chapitre terminal uniquement) : si le reader vient de
   *   journaliser le chapitre `to` il y a moins de
   *   {@link DEDUP_WINDOW_MINUTES} minutes, il est exclu du backfill.
   *
   * @param manager EntityManager transactionnel optionnel (transaction du
   *   pointeur dans `LibraryService.updateChapter`).
   * @returns Nombre de lignes insérées.
   */
  async recordBackfill(
    userId: number,
    muId: number,
    fromExclusive: number,
    toInclusive: number,
    manager?: EntityManager,
  ): Promise<number> {
    const end = Math.floor(toInclusive);
    let start = Math.floor(fromExclusive) + 1;
    if (end < start) return 0;

    const delta = end - start + 1;
    if (delta > BACKFILL_CAP) {
      this.logger.warn(
        `Backfill capped at ${BACKFILL_CAP} rows for user ${userId} manga ${muId} (delta=${delta}) — only chapters ${
          end - BACKFILL_CAP + 1
        }..${end} are logged`,
      );
      start = end - BACKFILL_CAP + 1;
    }

    const repo = manager
      ? manager.getRepository(UserMangaChapterLog)
      : this.logRepo;

    // B-5 : le chapitre terminal a pu être journalisé par le reader juste
    // avant le PUT /library/chapter — on ne le double pas.
    const recentTerminal = await this.findRecentRead(userId, muId, end, repo);

    const rows: UserMangaChapterLog[] = [];
    for (let chapter = start; chapter <= end; chapter++) {
      if (recentTerminal !== null && chapter === end) continue;
      const log = new UserMangaChapterLog();
      log.user = { id: userId } as User;
      log.manga = { mu_id: muId.toString() } as Manga;
      log.chapterNumber = chapter;
      log.isBonus = false;
      log.isSkipped = false;
      log.scrollPosition = null;
      rows.push(log);
    }
    if (rows.length === 0) return 0;

    for (let i = 0; i < rows.length; i += BACKFILL_INSERT_CHUNK_SIZE) {
      await repo.insert(rows.slice(i, i + BACKFILL_INSERT_CHUNK_SIZE));
    }
    return rows.length;
  }

  /**
   * Cherche une ligne de lecture (non-skippée) pour (user, manga, chapitre)
   * plus récente que la fenêtre d'idempotence {@link DEDUP_WINDOW_MINUTES}.
   * L'index (user_id, manga_id, chapterNumber) couvre le lookup.
   */
  private async findRecentRead(
    userId: number,
    muId: number,
    chapterNumber: number,
    repo: Repository<UserMangaChapterLog> = this.logRepo,
  ): Promise<UserMangaChapterLog | null> {
    const windowStart = new Date(Date.now() - DEDUP_WINDOW_MINUTES * 60 * 1000);
    return repo
      .createQueryBuilder('log')
      .where('log.user_id = :userId', { userId })
      .andWhere('log.manga_id = :mangaId', { mangaId: muId.toString() })
      .andWhere('log.chapterNumber = :chapterNumber', { chapterNumber })
      .andWhere('log.isSkipped = :skipped', { skipped: false })
      .andWhere('log.readAt >= :windowStart', { windowStart })
      .orderBy('log.readAt', 'DESC')
      .getOne();
  }
}
