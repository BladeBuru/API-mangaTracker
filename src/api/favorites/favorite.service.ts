import { Injectable } from '@nestjs/common';

import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import User from 'src/api/user/user.entity';
import { Manga } from 'src/api/mangas/manga.entity';
import { UserMangaFavorite } from '@/api/favorites/user-manga-favorite.entity';
import { MangaQuickViewDto } from '@/api/mangas/dto/manga-quick-view.dto';
import { UpdateMangaService } from '../mangas/update-manga.service';

@Injectable()
export class FavoriteService {
  constructor(
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    @InjectRepository(UserMangaFavorite)
    private readonly userFavoriteMangaRepository: Repository<UserMangaFavorite>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly updateMangaService: UpdateMangaService,
  ) {}

  async addFavoriteManga(
    mangaId: number,
    userId: number,
  ): Promise<MangaQuickViewDto[]> {
    const manga: Manga = await this.mangaRepository.findOne({
      where: { id: mangaId },
      relations: ['favoriteMangas'],
    });

    const user: User = await this.userRepository.findOne({
      where: { id: mangaId },
    });

    const userFavoriteManga = new UserMangaFavorite();

    userFavoriteManga.user = user;
    userFavoriteManga.manga = manga;

    if (await this.userFavoriteMangaRepository.findOneBy(userFavoriteManga)) {
      return;
    }
    await this.userFavoriteMangaRepository.save(userFavoriteManga);
    return this.getFavoriteManga(userId);
  }
  async getFavoriteManga(userId: number): Promise<MangaQuickViewDto[]> {
    let userMangas = await this.mangaRepository
      .createQueryBuilder('manga')
      .leftJoinAndSelect(
        UserMangaFavorite,
        'usereMangaFavorite',
        'usereMangaFavorite.manga_id = manga.id',
      )
      .leftJoinAndSelect(User, 'user', 'user.id = usereMangaFavorite.user_id')
      .where('user.id = :id', { id: userId })
      .getRawMany();

    const mangaIds = await this.updateMangaService.getMangasIds(userMangas);
    const updatedMangas: Manga[] =
      await this.updateMangaService.checkIfMangaArrayInfoIsOutdated(mangaIds);

    /* 
    New request for getting updated content if previous mangas were
    outdated 
    */
    if (updatedMangas.length !== 0) {
      userMangas = await this.mangaRepository
        .createQueryBuilder('manga')
        .leftJoinAndSelect(
          UserMangaFavorite,
          'usereMangaFavorite',
          'usereMangaFavorite.manga_id = manga.id',
        )
        .leftJoinAndSelect(User, 'user', 'user.id = usereMangaFavorite.user_id')
        .where('user.id = :id', { id: userId })
        .getRawMany();
    }
    const nbMangas = userMangas.length;
    const userMangasQuickView: MangaQuickViewDto[] = new Array(nbMangas);
    for (let i = 0; i < nbMangas; i++) {
      userMangasQuickView[i] = MangaQuickViewDto.fromLibrary(userMangas[i]);
    }

    return userMangasQuickView;
  }

  async deleteFavoriteManga(
    mangaId: number,
    userId: number,
  ): Promise<MangaQuickViewDto[]> {
    const manga: Manga = await this.mangaRepository.findOne({
      where: { id: mangaId },
      relations: ['favoriteMangas'],
    });
    const user: User = await this.userRepository.findOne({
      where: { id: mangaId },
    });
    const userFavoriteManga = new UserMangaFavorite();
    userFavoriteManga.user = user;
    userFavoriteManga.manga = manga;
    await this.userFavoriteMangaRepository.delete(userFavoriteManga);
    return this.getFavoriteManga(userId);
  }
}
