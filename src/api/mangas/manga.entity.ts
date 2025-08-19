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

  @Column({ type: 'json', nullable: true })
  associated?: string[];

  @Column({ type: 'json', nullable: true })
  genres?: string[];

  @Column({ type: 'json', nullable: true })
  recommendations?: string[];

  @Column({ default: 'Manga' })
  type: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToMany(() => UserManga, (userManga) => userManga.manga)
  user_mangas: UserManga[];

  static fromMU(mangaDetailsDto: MangaDetailsDto): Manga {
    if (!mangaDetailsDto) {
      throw new Error('fromMU: mangaDetailsDto is undefined/null');
    }
    const muId =
      (mangaDetailsDto as any).muId ?? (mangaDetailsDto as any).mu_id;
    if (muId === undefined || muId === null) {
      throw new Error('fromMU: muId is missing');
    }
    const manga = new Manga();
    manga['title'] = mangaDetailsDto['title'];
    manga['year'] = mangaDetailsDto['year'];
    manga['small_cover_url'] = mangaDetailsDto['smallCoverUrl'];
    manga['medium_cover_url'] = mangaDetailsDto['mediumCoverUrl'];
    manga['mu_id'] = muId.toString();
    manga['total_chapters'] = mangaDetailsDto['totalChapters'];
    manga['rating'] = mangaDetailsDto['rating'];
    manga['completed'] = mangaDetailsDto['completed'];
    manga['associated'] = mangaDetailsDto['associated'] ?? [];
    manga['genres'] = mangaDetailsDto['genres'] ?? [];
    manga['recommendations'] = mangaDetailsDto['recommendations'] ?? [];
    manga['type'] = mangaDetailsDto['type'];
    return manga;
  }
}
