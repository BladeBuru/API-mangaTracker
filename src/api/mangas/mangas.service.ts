import { Injectable } from '@nestjs/common';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import User from "@/api/user/user.entity";
import {UserFavoriteManga} from "@/api/user/userFavoris.entity";

@Injectable()
export class  MangasService {

  @InjectRepository(Manga)
  private readonly mangaRepository: Repository<Manga>;
  @InjectRepository(UserFavoriteManga)
    private readonly userFavoriteMangaRepository: Repository<UserFavoriteManga>;


  @InjectRepository(User)
  private readonly userRepository: Repository<User>;




  async addFavoriteManga(mangaId: number, user: User): Promise<void> {
    const manga: Manga = await this.mangaRepository.findOne({
      where: { id: mangaId },
      relations: ['favoriteMangas'],
    });
      const userFavoriteManga = new UserFavoriteManga();
      userFavoriteManga.user = user;
      userFavoriteManga.manga = manga;
    await this.userFavoriteMangaRepository.save(userFavoriteManga);
  }

    async getFavoriteManga(userId: number): Promise<Manga[]> {
        const user: User = await this.userRepository.findOne({
            where: { id: userId },
            relations: ['favoriteMangas'],
        });
        return user.favoriteMangas.map((userFavoriteManga) => userFavoriteManga.manga);
    }

    async deleteFavoriteManga(mangaId: number, userId: number): Promise<void> {
        const manga: Manga = await this.mangaRepository.findOne({
            where: { id: mangaId },
            relations: ['favoriteMangas'],
        });
        const user: User = await this.userRepository.findOne({
            where: { id: userId },
            relations: ['favoriteMangas'],
        });
        const userFavoriteManga = user.favoriteMangas.find((userFavoriteManga) => userFavoriteManga.manga.id === manga.id);
        await this.userFavoriteMangaRepository.delete(userFavoriteManga.id);
    }
}
