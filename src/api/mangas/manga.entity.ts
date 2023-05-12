import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { UserManga } from './user-manga.entity';
import {UserMangaFavorite} from "@/api/favorites/user-manga-favorite.entity";

@Entity()
export class Manga {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  title: string;

  @Column()
  smallCoverUrl: string;

  @Column()
  mediumCoverUrl: string;

  @Column({ type: 'bigint' })
  muId: string;

  @Column({ default: 0 })
  totalChapters: number;

  @Column('decimal', { precision: 3, scale: 2 })
  rating: number;

  @Column()
  year: number;

  @OneToMany(() => UserManga, (userManga) => userManga.manga)
  userMangas: UserManga[];

  @OneToMany(() => UserMangaFavorite, (userFavoriteManga) => userFavoriteManga.manga)
  favoriteMangas: UserMangaFavorite[];

  static fromMU(mangaDetailsDto: MangaDetailsDto): Manga {
    const manga = new Manga();
    manga['title'] = mangaDetailsDto['title'];
    manga['year'] = mangaDetailsDto['year'];
    manga['smallCoverUrl'] = mangaDetailsDto['smallCoverUrl'];
    manga['mediumCoverUrl'] = mangaDetailsDto['mediumCoverUrl'];
    manga['muId'] = mangaDetailsDto['muId'].toString();
    manga['totalChapters'] = mangaDetailsDto['latestChapter'];
    manga['rating'] = mangaDetailsDto['rating'];
    return manga;
  }
}
