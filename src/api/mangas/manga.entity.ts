import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { UserManga } from './user-manga.entity';

@Entity()
export class Manga {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  title: string;

  @Column()
  small_cover_url: string;

  @Column()
  medium_cover_url: string;

  @Column({ type: 'bigint', unique: true })
  mu_id: string;

  @Column({ default: 0 })
  total_chapters: number;

  @Column('decimal', { precision: 3, scale: 2 })
  rating: number;

  @Column()
  year: number;

  @Column({ nullable: true })
  completed: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToMany(() => UserManga, (userManga) => userManga.manga)
  user_mangas: UserManga[];

  static fromMU(mangaDetailsDto: MangaDetailsDto): Manga {
    const manga = new Manga();
    manga['title'] = mangaDetailsDto['title'];
    manga['year'] = mangaDetailsDto['year'];
    manga['small_cover_url'] = mangaDetailsDto['small_cover_url'];
    manga['medium_cover_url'] = mangaDetailsDto['medium_cover_url'];
    manga['mu_id'] = mangaDetailsDto['mu_id'].toString();
    manga['total_chapters'] = mangaDetailsDto['total_chapters'];
    manga['rating'] = mangaDetailsDto['rating'];
    manga['completed'] = mangaDetailsDto['completed'];
    return manga;
  }
}
