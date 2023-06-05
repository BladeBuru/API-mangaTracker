import {
  BadRequestException,
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

@Injectable()
export class LibraryService {
  constructor(
    private readonly userService: UserService,
    private readonly mangasService: MangasService,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    @InjectRepository(UserManga)
    private readonly userMangaRepository: Repository<UserManga>,
  ) {}

  async saveManga(muId: number, userId: number): Promise<MangaDetailsDto> {
    const mangaDto = await this.mangasService.getMangaDetails(muId);
    const manga = Manga.fromMU(mangaDto);

    const userEntity = await this.userService.returnUserIfExist(userId);

    if (userEntity === null)
      throw new NotFoundException(`User with id ${userId} does not exist`);

    let mangaEntity = await this.returnMangaIfExist(muId.toString());

    if (mangaEntity === null) {
      mangaEntity = await this.mangaRepository.save(manga);
    }

    const userMangaEntityInDB = await this.userMangaRepository.findOneBy({
      user: userEntity,
      manga: mangaEntity,
    });

    if (userMangaEntityInDB !== null)
      throw new BadRequestException('Manga already saved');

    const userManga = new UserManga();
    userManga.user = userEntity;
    userManga.manga = mangaEntity;
    await this.userMangaRepository.save(userManga);
    return mangaDto;
  }

  async getMangas(userId: number): Promise<MangaQuickViewDto[]> {
    const userMangas = await this.mangaRepository
      .createQueryBuilder('manga')
      .leftJoinAndSelect(
        UserManga,
        'userManga',
        'userManga.manga_id = manga.id',
      )
      .leftJoinAndSelect(User, 'user', 'user.id = userManga.user_id')
      .where('user.id = :id', { id: userId })
      .getRawMany();

    const nbMangas = userMangas.length;
    const userMangasQuickView: MangaQuickViewDto[] = new Array(nbMangas);
    for (let i = 0; i < nbMangas; i++) {
      userMangasQuickView[i] = MangaQuickViewDto.fromLibrary(userMangas[i]);
    }
    return userMangasQuickView;
  }

  async returnMangaIfExist(muId: string): Promise<Manga> {
    const mangaEntity = await this.mangaRepository.findOneBy({
      mu_id: muId,
    });

    return mangaEntity;
  }

  async deleteManga(userId: number, muId: number): Promise<boolean> {
    const userEntity = await this.userService.returnUserIfExist(userId);

    if (userEntity === null)
      throw new NotFoundException(`User with id ${userId} does not exist`);

    const mangaEntity = await this.returnMangaIfExist(muId.toString());

    if (mangaEntity === null)
      throw new NotFoundException(
        `Manga with id ${muId} does not exist or is not present in user\'s library`,
      );

    const deletedMangaInLibrary = await this.userMangaRepository
      .createQueryBuilder('userManga')
      .leftJoinAndSelect(Manga, 'manga', 'manga.id = userManga.manga_id')
      .leftJoinAndSelect(User, 'user', 'user.id = userManga.user_id')
      .where('user.id = :id', { id: userId })
      .andWhere('manga.mu_id = :muId', { muId: muId.toString() })
      .getMany()
      .then((targetedMangasInLibrary) => {
        return this.userMangaRepository.remove(targetedMangasInLibrary);
      });

    if (deletedMangaInLibrary.length != 1)
      throw new NotFoundException(
        `Nothing found in user's library for userId: ${userId} and muId: ${muId} `,
      );
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

    const mangaEntity = await this.returnMangaIfExist(muId.toString());

    if (mangaEntity === null)
      throw new NotFoundException(
        `Manga with id ${muId} does not exist or is not present in user\'s library`,
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
