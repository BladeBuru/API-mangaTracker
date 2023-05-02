import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { UserManga } from './user-manga.entity';

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

  @Column()
  muId: number;

  @Column({ default: 0 })
  totalChapters: number;

  @Column({ default: 0 })
  readChapters: number;

  @Column()
  rating: number;

  @Column()
  year: number;

  @OneToMany(() => UserManga, (userManga) => userManga.manga)
  userMangas: UserManga[];

  static fromMU(mangaDetailsDto: MangaDetailsDto): Manga {
    console.log(mangaDetailsDto);
    const manga = new Manga();
    manga['title'] = mangaDetailsDto['title'];
    manga['year'] = mangaDetailsDto['year'];
    manga['smallCoverUrl'] = mangaDetailsDto['smallCoverUrl'];
    manga['mediumCoverUrl'] = mangaDetailsDto['mediumCoverUrl'];
    manga['muId'] = mangaDetailsDto['muId'];
    manga['totalChapters'] = mangaDetailsDto['latestChapter'];
    manga['rating'] = mangaDetailsDto['rating'];
    return manga;
  }
}
