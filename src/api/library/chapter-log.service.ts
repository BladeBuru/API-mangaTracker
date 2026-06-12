import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserMangaChapterLog } from './user-manga-chapter-log.entity';
import { Manga } from '@/api/mangas/manga.entity';
import User from '@/api/user/user.entity';
import { ChapterLogEntryDto, RecordChapterLogDto } from './dto/chapter-log.dto';

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
}
