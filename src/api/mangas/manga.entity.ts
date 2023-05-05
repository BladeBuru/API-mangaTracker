import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { MangaDetailsDto } from './dto/manga-details.dto';
import {UserFavoriteManga} from "@/api/user/userFavoris.entity";

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


  @OneToMany(() => UserFavoriteManga, (userFavoriteManga) => userFavoriteManga.manga)
  favoriteMangas: UserFavoriteManga[];

  static fromMU(mangaDetailsDto: MangaDetailsDto): Manga {
    console.log(mangaDetailsDto);
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