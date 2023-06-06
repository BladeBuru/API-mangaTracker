import {
    Injectable,
} from '@nestjs/common';

import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import User from 'src/api/user/user.entity';
import { Manga } from 'src/api/mangas/manga.entity';
import {UserMangaFavorite} from "@/api/favorites/user-manga-favorite.entity";
import {MangaQuickViewDto} from "@/api/mangas/dto/manga-quick-view.dto";
import {AuthenticatedUser} from "@/api/user/auth/authentificated-user.interface";

@Injectable()
export class FavoriteService {
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>;
    @InjectRepository(UserMangaFavorite)
    private readonly userFavoriteMangaRepository: Repository<UserMangaFavorite>;
    @InjectRepository(User)
    private readonly userRepository: Repository<User>;




    async addFavoriteManga(mangaId: number, user: AuthenticatedUser): Promise<MangaQuickViewDto[]> {
        const manga: Manga = await this.mangaRepository.findOne({
            where: { id: mangaId },
            relations: ['favoriteMangas'],
        });
        const userFavoriteManga = new UserMangaFavorite();
        userFavoriteManga.user = user as User;
        userFavoriteManga.manga = manga;
        if (await this.userFavoriteMangaRepository.findOneBy(userFavoriteManga)) {
            return;
        }
        await this.userFavoriteMangaRepository.save(userFavoriteManga);
        return this.getFavoriteManga(user.id);
    }
    async getFavoriteManga(userId: number): Promise<MangaQuickViewDto[]> {
        const userMangas = await this.mangaRepository
            .createQueryBuilder('manga')
            .leftJoinAndSelect(
                UserMangaFavorite,
                'usereMangaFavorite',
                'usereMangaFavorite.manga_id = manga.id',
            )
            .leftJoinAndSelect(User, 'user', 'user.id = usereMangaFavorite.user_id')
            .where('user.id = :id', { id: userId })
            .getRawMany();

        const nbMangas = userMangas.length;
        const userMangasQuickView: MangaQuickViewDto[] = new Array(nbMangas);
        for (let i = 0; i < nbMangas; i++) {
            userMangasQuickView[i] = MangaQuickViewDto.fromLibrary(userMangas[i]);
        }

        return userMangasQuickView;
    }

    async deleteFavoriteManga(mangaId: number,user: User):  Promise<MangaQuickViewDto[]>{
        const manga: Manga = await this.mangaRepository.findOne({
            where: { id: mangaId },
            relations: ['favoriteMangas'],
        });
        const userFavoriteManga = new UserMangaFavorite();
        userFavoriteManga.user = user;
        userFavoriteManga.manga = manga;
        await this.userFavoriteMangaRepository.delete(userFavoriteManga)
        return this.getFavoriteManga(user.id);
    }
}
