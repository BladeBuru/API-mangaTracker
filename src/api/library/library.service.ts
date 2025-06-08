import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserService } from 'src/api/user/user.service';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
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

@Injectable()
export class LibraryService {
  constructor(
    private readonly userService: UserService,
    private readonly mangasService: MangasService,
    private readonly updateMangaService: UpdateMangaService,
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
    return await this.mangasService.getMangaDetails(muId);
  }

  async getMangas(userId: number): Promise<MangaQuickViewDto[]> {
    let user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['user_mangas', 'user_mangas.manga'],
    });

    const mangaIds = await this.updateMangaService.getMangasIds(
      user.user_mangas,
    );
    const updatedMangas: Manga[] =
      await this.updateMangaService.checkIfMangaArrayInfoIsOutdated(mangaIds);

    /* 
    New request for getting updated content if previous mangas were
    outdated 
    */
    if (updatedMangas.length !== 0) {
      user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['user_mangas', 'user_mangas.manga'],
      });
    }

    return user.user_mangas
      .slice() // Copy of user.user_mangas
      .sort(
        (a, b) =>
          new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
      ) // Sort by date of last update of the manga in descending order
      .map((a) => MangaQuickViewDto.fromLibrary(a));
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

    if (readChapters > mangaEntity.total_chapters)
      throw new ChapterException(
        `${readChapters} (new value) is above ${mangaEntity.total_chapters} (total number of chapters)`,
      );

    const allAvailableChaptersReadStatus = mangaEntity.completed
      ? ReadingStatus.Completed
      : ReadingStatus.CaughtUp;

    await this.userMangaRepository
      .createQueryBuilder()
      .update(UserManga)
      .set({
        user_read_chapters: readChapters,
        readingStatus:
          readChapters < mangaEntity.total_chapters
            ? ReadingStatus.Reading
            : allAvailableChaptersReadStatus,
        lastUpdated: new Date(),
      })
      .where('user_id = :id', { id: userId })
      .andWhere('manga_id = :muId', { muId: muId.toString() })
      .execute();

    return true;
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

      await this.mangaRepository
        .createQueryBuilder()
        .update(Manga)
        .set({
          completed: mangaDetails.completed,
          total_chapters: mangaDetails.total_chapters,
        })
        .where('mu_id = :muId', { muId: muId.toString() })
        .execute();
    }

    return await this.mangasService.returnMangaIfExist(muId.toString());
  }
}
