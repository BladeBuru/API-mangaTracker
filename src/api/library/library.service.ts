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
import { UpdateMangaService } from '../mangas/update-manga.service';

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

  async saveManga(muId: number, user: User): Promise<MangaDetailsDto> {
    const mangaDto = await this.mangasService.getMangaDetails(muId);
    const manga = Manga.fromMU(mangaDto);

    let mangaEntity = await this.mangasService.returnMangaIfExist(
      muId.toString(),
    );

    if (mangaEntity === null) {
      mangaEntity = await this.mangaRepository.save(manga);
    }

    const userMangaEntityInDB = await this.userMangaRepository.findOneBy({
      user: { id: user.id },
      manga: { mu_id: mangaEntity.mu_id },
    });

    if (userMangaEntityInDB !== null)
      throw new BadRequestException('Manga already saved');

    const userManga = new UserManga();
    userManga.user = user;
    userManga.manga = mangaEntity;
    await this.userMangaRepository.save(userManga);
    return mangaDto;
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

    const nbMangas = user.user_mangas.length;
    const userMangasQuickView: MangaQuickViewDto[] = new Array(nbMangas);
    for (let i = 0; i < nbMangas; i++) {
      userMangasQuickView[i] = MangaQuickViewDto.fromLibrary(
        user.user_mangas[i],
      );
    }
    return userMangasQuickView;
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
    const userEntity = await this.userService.returnUserIfExist(userId);

    if (userEntity === null)
      throw new NotFoundException(`User with id ${userId} does not exist`);

    const mangaEntity = await this.mangasService.returnMangaIfExist(
      muId.toString(),
    );

    if (mangaEntity === null)
      throw new NotFoundException(
        `Manga with id ${muId} does not exist or is not present in user\'s library`,
      );

    if (readChapters > mangaEntity.total_chapters)
      throw new ChapterException(
        `${readChapters} (new value) is above ${mangaEntity.total_chapters} (total number of chapters)`,
      );

    await this.userMangaRepository
      .createQueryBuilder()
      .update(UserManga)
      .set({ user_read_chapters: readChapters })
      .where('user_id = :id', { id: userId })
      .andWhere('manga_id = :muId', { muId: muId.toString() })
      .execute();

    return true;
  }
}
