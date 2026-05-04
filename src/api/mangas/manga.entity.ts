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
  associated?: { title: string }[];

  /**
   * Genres extraits de MangaUpdates (`Action`, `Romance`, `Comedy`...).
   * Stocké JSON pour requêtage simple par contains. Filtrage des NSFW
   * fait au niveau de la requête ou de l'aggregation, pas du stockage.
   */
  @Column({ type: 'json', nullable: true })
  genres?: string[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToMany(() => UserManga, (userManga) => userManga.manga)
  user_mangas: UserManga[];

  static fromMU(mangaDetailsDto: MangaDetailsDto): Manga {
    if (!mangaDetailsDto) {
      throw new Error('fromMU: mangaDetailsDto est undefined/null');
    }
    const muId =
      (mangaDetailsDto as any).muId ?? (mangaDetailsDto as any).mu_id;
    if (muId === undefined || muId === null) {
      throw new Error('fromMU: muId est manquant');
    }
    const manga = new Manga();
    manga['title'] = mangaDetailsDto['title'] ?? mangaDetailsDto['title'];
    manga['year'] = mangaDetailsDto['year'] ?? mangaDetailsDto['year'];
    manga['small_cover_url'] =
      mangaDetailsDto['small_cover_url'] ?? mangaDetailsDto['smallCoverUrl'];
    manga['medium_cover_url'] =
      mangaDetailsDto['medium_cover_url'] ?? mangaDetailsDto['mediumCoverUrl'];
    manga['mu_id'] = muId.toString();
    manga['total_chapters'] =
      mangaDetailsDto['total_chapters'] ?? mangaDetailsDto['totalChapters'];
    manga['rating'] = mangaDetailsDto['rating'];
    manga['completed'] = mangaDetailsDto['completed'];
    manga['associated'] = mangaDetailsDto['associated'] ?? [];
    // genres : MU les renvoie sous forme `[{genre: "Action"}, {genre: "Romance"}]`
    // ou parfois directement `["Action", ...]`. On normalise.
    const rawGenres = (mangaDetailsDto as any).genres ?? [];
    manga['genres'] = Array.isArray(rawGenres)
      ? rawGenres
          .map((g: any) =>
            typeof g === 'string' ? g : (g?.genre ?? g?.name ?? ''),
          )
          .filter((g: string) => g.length > 0)
      : null;
    return manga;
  }
}
