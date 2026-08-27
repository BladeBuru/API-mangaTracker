import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UserService } from 'src/api/user/user.service';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import User from 'src/api/user/user.entity';
import { Manga } from 'src/api/mangas/manga.entity';
import { UserManga } from 'src/api/mangas/user-manga.entity';
import { MangasService } from 'src/api/mangas/mangas.service';
import { MangaDetailsDto } from 'src/api/mangas/dto/manga-details.dto';
import { MangaQuickViewDto } from 'src/api/mangas/dto/manga-quick-view.dto';
import { ChapterException } from './exceptions/chapter.exception';
import { ReadingStatusException } from './exceptions/reading-status.exception';
import { UpdateMangaService } from '../mangas/update-manga.service';
import {
  getReadingStatus,
  isReadingStatus,
  ReadingStatus,
} from './reading-status.enum';
import { RecoCacheService } from '@/api/recommendations/reco-cache.service';
import { ChapterLogService } from './chapter-log.service';
import { ChapterReportService } from './chapter-report.service';

@Injectable()
export class LibraryService {
  private readonly logger = new Logger(LibraryService.name);

  constructor(
    private readonly userService: UserService,
    private readonly mangasService: MangasService,
    private readonly updateMangaService: UpdateMangaService,
    private readonly recoCache: RecoCacheService,
    private readonly chapterLogService: ChapterLogService,
    private readonly chapterReportService: ChapterReportService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    @InjectRepository(UserManga)
    private readonly userMangaRepository: Repository<UserManga>,
  ) {}

  async saveManga(muId: number, userId: number): Promise<MangaDetailsDto> {
    const userEntity = await this.checkUser(userId);
    const mangaEntity = await this.checkManga(muId);

    const existingUserMangaEntity = await this.userMangaRepository
      .createQueryBuilder()
      .where('user_id = :id', { id: userId })
      .andWhere('manga_id = :muId', { muId: muId.toString() })
      .getOne();

    if (existingUserMangaEntity !== null)
      throw new BadRequestException('Manga already saved');

    const userManga = new UserManga();
    userManga.user = userEntity;
    userManga.manga = mangaEntity;
    userManga.lastUpdated = new Date();
    await this.userMangaRepository.save(userManga);
    // La biblio a changé → les recos doivent le refléter immédiatement.
    this.recoCache.invalidateUser(userId);
    return await this.mangasService.getMangaDetails(muId);
  }

  async getMangas(userId: number): Promise<MangaQuickViewDto[]> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['user_mangas', 'user_mangas.manga'],
    });

    const mangaIds = await this.updateMangaService.getMangasIds(
      user.user_mangas,
    );

    // Les mises à jour sont lancées en arrière-plan par checkIfMangaArrayInfoIsOutdated
    // On ne re-requête plus la BDD après : les données fraîches seront visibles à la prochaine ouverture
    this.updateMangaService
      .checkIfMangaArrayInfoIsOutdated(mangaIds)
      .catch((err) =>
        this.logger.warn(`Background manga array update failed: ${err}`),
      );

    // Chantier A : reports « plus de chapitres » de l'user (1 requête IN,
    // pas de N+1) — exposés via totalChapters effectif dans le DTO.
    const reports = await this.chapterReportService.getUserReportsByMangaIds(
      userId,
      mangaIds,
    );

    return user.user_mangas
      .slice()
      .sort(
        (a, b) =>
          new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
      )
      .map((a) => MangaQuickViewDto.fromLibrary(a, reports.get(a.manga.mu_id)));
  }

  async deleteManga(userId: number, muId: number): Promise<boolean> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['user_mangas', 'user_mangas.manga'],
    });

    if (user === null)
      throw new NotFoundException(`User with id ${userId} does not exist`);

    const mangaToDelete = user.user_mangas.filter(
      (userManga) => userManga.manga.mu_id === muId.toString(),
    );

    if (mangaToDelete.length === 1) {
      await this.userMangaRepository.remove(mangaToDelete[0]);
      this.recoCache.invalidateUser(userId);
    } else if (mangaToDelete.length > 1) {
      throw new ConflictException(
        'Too much records found in user library for given muId',
      );
    } else {
      throw new NotFoundException(
        `Nothing found in user's library for userId: ${userId} and muId: ${muId} `,
      );
    }
    return true;
  }

  async updateChapter(
    userId: number,
    muId: number,
    readChapters: number,
  ): Promise<boolean> {
    const mangaToUpdate = (await this.checkUser(userId)).user_mangas.filter(
      (userManga) => userManga.manga.mu_id === muId.toString(),
    );

    if (mangaToUpdate.length === 0) {
      throw new NotFoundException(
        `Nothing found in user's library for userId: ${userId} and muId: ${muId} `,
      );
    }

    const mangaEntity = await this.checkManga(muId);

    // Chantier A : cap 406 sur le total EFFECTIF = max(officiel, report).
    const effectiveTotal = await this.chapterReportService.getEffectiveTotal(
      userId,
      muId,
      mangaEntity.total_chapters,
    );

    if (readChapters > effectiveTotal)
      throw new ChapterException(
        `${readChapters} (new value) is above ${effectiveTotal} (effective total number of chapters)`,
      );

    const readingStatus =
      readChapters < effectiveTotal
        ? ReadingStatus.Reading
        : mangaEntity.completed
        ? ReadingStatus.Completed
        : ReadingStatus.CaughtUp;

    // Edge connu (NON corrigé — sur-ingénierie pour le volume actuel) : deux
    // PUT /library/chapter concurrents pour le même (user, manga) lisent le
    // MÊME `oldReadChapters` sans SELECT ... FOR UPDATE. Le pointeur converge
    // (dernier write gagne, applyChapterPointer est monotone), mais le
    // backfill du journal peut alors journaliser deux fois un intervalle qui
    // se chevauche (quelques lignes de log dupliquées, jamais de perte de
    // progression). Un verrou de ligne (FOR UPDATE) sur `oldReadChapters`
    // serait la vraie parade si le trafic concurrent le justifie un jour.
    const oldReadChapters = mangaToUpdate[0].user_read_chapters;
    await this.persistChapterProgress(
      userId,
      muId,
      readChapters,
      readingStatus,
      oldReadChapters,
    );

    // La progression influe sur le scoring des recos (statut/récence).
    this.recoCache.invalidateUser(userId);
    return true;
  }

  /**
   * Chantier B : écrit le pointeur et, si la progression AVANCE, backfill
   * le journal (oldRead+1..readChapters) dans la même transaction.
   * Décrément/no-op (B-4) : journal additif, seul le pointeur bouge.
   * Fallback séquentiel : si la transaction échoue, le pointeur prime —
   * UPDATE seul puis backfill best-effort (logger.warn).
   */
  private async persistChapterProgress(
    userId: number,
    muId: number,
    readChapters: number,
    readingStatus: ReadingStatus,
    oldReadChapters: number,
  ): Promise<void> {
    if (readChapters <= oldReadChapters) {
      await this.applyChapterPointer(userId, muId, readChapters, readingStatus);
      return;
    }

    try {
      await this.dataSource.transaction(async (manager) => {
        await this.applyChapterPointer(
          userId,
          muId,
          readChapters,
          readingStatus,
          manager,
        );
        await this.chapterLogService.recordBackfill(
          userId,
          muId,
          oldReadChapters,
          readChapters,
          manager,
        );
      });
    } catch (err) {
      this.logger.warn(
        `updateChapter transaction failed for user ${userId} manga ${muId} — sequential fallback: ${err}`,
      );
      await this.applyChapterPointer(userId, muId, readChapters, readingStatus);
      try {
        await this.chapterLogService.recordBackfill(
          userId,
          muId,
          oldReadChapters,
          readChapters,
        );
      } catch (backfillErr) {
        this.logger.warn(
          `Chapter log backfill failed for user ${userId} manga ${muId}: ${backfillErr}`,
        );
      }
    }
  }

  /** UPDATE du pointeur de progression (transactionnel si manager fourni). */
  private async applyChapterPointer(
    userId: number,
    muId: number,
    readChapters: number,
    readingStatus: ReadingStatus,
    manager?: EntityManager,
  ): Promise<void> {
    const queryBuilder = manager
      ? manager.createQueryBuilder()
      : this.userMangaRepository.createQueryBuilder();
    await queryBuilder
      .update(UserManga)
      .set({
        user_read_chapters: readChapters,
        readingStatus,
        lastUpdated: new Date(),
      })
      .where('user_id = :id', { id: userId })
      .andWhere('manga_id = :muId', { muId: muId.toString() })
      .execute();
  }

  async updateReadingStatus(
    userId: number,
    muId: number,
    readingStatus: string,
  ): Promise<boolean> {
    const mangaToUpdate = (await this.checkUser(userId)).user_mangas.filter(
      (userManga) => userManga.manga.mu_id === muId.toString(),
    );

    if (mangaToUpdate.length === 0) {
      throw new NotFoundException(
        `Nothing found in user's library for userId: ${userId} and muId: ${muId} `,
      );
    }

    await this.checkManga(muId);

    if (!isReadingStatus(readingStatus))
      throw new ReadingStatusException(
        `${readingStatus} isn't a valid value for the reading status (possible values are: ${getReadingStatus().join(
          ', ',
        )})`,
      );

    await this.userMangaRepository
      .createQueryBuilder()
      .update(UserManga)
      .set({ readingStatus: readingStatus, lastUpdated: new Date() })
      .where('user_id = :id', { id: userId })
      .andWhere('manga_id = :muId', { muId: muId.toString() })
      .execute();

    // Le statut de lecture est un multiplicateur du scoring des recos.
    this.recoCache.invalidateUser(userId);
    return true;
  }

  async checkUser(userId: number): Promise<User> {
    const userEntity = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['user_mangas', 'user_mangas.manga'],
    });

    if (userEntity === null)
      throw new NotFoundException(`User with id ${userId} does not exist`);

    return userEntity;
  }

  async checkManga(muId: number): Promise<Manga> {
    const mangaEntity = await this.mangasService.returnMangaIfExist(
      muId.toString(),
    );

    if (mangaEntity === null) {
      await this.mangaRepository.save(
        Manga.fromMU(await this.mangasService.getMangaDetails(muId)),
      );
    } else if (
      mangaEntity.updated_at < new Date(new Date().getTime() - 21600000) ||
      mangaEntity.completed === null
    ) {
      const mangaDetails = Manga.fromMU(
        await this.mangasService.getMangaDetails(muId),
      );

      // A-5 : GREATEST inconditionnel — total_chapters ne régresse jamais
      // (regex status MU peu fiable, cf. decisions.md). completed écrasé.
      await this.mangaRepository
        .createQueryBuilder()
        .update(Manga)
        .set({
          completed: mangaDetails.completed,
          total_chapters: () => 'GREATEST(total_chapters, :newTotal)',
        })
        .setParameter('newTotal', Number(mangaDetails.total_chapters) || 0)
        .where('mu_id = :muId', { muId: muId.toString() })
        .execute();
    }

    return await this.mangasService.returnMangaIfExist(muId.toString());
  }

  async getUserManga(userId: number, muId: number): Promise<UserManga | null> {
    return this.userMangaRepository.findOne({
      where: { user: { id: userId }, manga: { mu_id: muId.toString() } },
      relations: ['user', 'manga'],
    });
  }

  /** Charge l'entrée bibliothèque (user, manga) ou throw 404. */
  private async findUserMangaOrThrow(
    userId: number,
    muId: number,
  ): Promise<UserManga> {
    const userManga = await this.getUserManga(userId, muId);
    if (!userManga) {
      throw new NotFoundException(
        `No manga found in user library for userId: ${userId} and muId: ${muId}`,
      );
    }
    return userManga;
  }

  async updateCustomLink(
    userId: number,
    muId: number,
    customLink: string,
  ): Promise<boolean> {
    const userManga = await this.findUserMangaOrThrow(userId, muId);
    userManga.custom_link = customLink;
    await this.userMangaRepository.save(userManga);
    return true;
  }

  async deleteCustomLink(userId: number, muId: number): Promise<boolean> {
    const userManga = await this.findUserMangaOrThrow(userId, muId);
    userManga.custom_link = null;
    await this.userMangaRepository.save(userManga);
    return true;
  }

  async updateRating(
    userId: number,
    muId: number,
    rating: number,
  ): Promise<boolean> {
    const userManga = await this.findUserMangaOrThrow(userId, muId);
    userManga.user_rating = rating;
    userManga.lastUpdated = new Date();
    await this.userMangaRepository.save(userManga);
    // La note user est un multiplicateur du scoring des recos.
    this.recoCache.invalidateUser(userId);
    return true;
  }
}
