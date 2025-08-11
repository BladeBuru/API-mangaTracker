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

  @Column('text')
  description: string;

  @Column({ nullable: true })
  status?: string;

  @Column({ name: 'publication_status', nullable: true })
  publication_status?: string;

  @Column({ type: 'bigint', unique: true })
  mu_id: string;

  @Column({ default: 0 })
  total_chapters: number;

  @Column({ name: 'season_chapters', type: 'simple-json', nullable: true })
  season_chapters?: { season: string; chapters: number }[];

  @Column({ name: 'bonus_chapters', type: 'simple-json', nullable: true })
  bonus_chapters?: { season: string; chapters: number }[];

  @Column('decimal', { precision: 3, scale: 2 })
  rating: number;

  @Column({ type: 'simple-json', nullable: true })
  authors?: any[];

  @Column({ type: 'simple-json', nullable: true })
  genres?: any[];

  @Column({ type: 'simple-json', nullable: true })
  anime?: any[];

  @Column({ type: 'simple-json', nullable: true })
  categories?: any[];

  @Column()
  year: number;

  @Column({ nullable: true })
  completed: boolean;

  @Column({ type: 'json', nullable: true })
  associated?: { title: string }[];

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToMany(() => UserManga, (userManga) => userManga.manga)
  user_mangas: UserManga[];

  static fromMU(dto: MangaDetailsDto): Manga {
    if (!dto) {
      throw new Error('fromMU: mangaDetailsDto est undefined/null');
    }

    const muId = (dto as any).muId ?? (dto as any).mu_id;
    if (muId === undefined || muId === null) {
      throw new Error('fromMU: muId est manquant');
    }
    const m = new Manga();
    m.title = dto.title;
    m.associated = dto.associated;
    m.description = dto.description;
    m.status = dto.status;
    m.publication_status = dto.publicationStatus;
    m.small_cover_url = dto.smallCoverUrl;
    m.medium_cover_url = dto.mediumCoverUrl;
    m.mu_id = dto.muId.toString();
    m.total_chapters = dto.totalChapters;
    m.rating = dto.rating;
    m.year = dto.year;
    m.completed = dto.completed;
    m.season_chapters = dto.seasonChapters;
    m.bonus_chapters = dto.bonusChapters;
    m.authors = dto.authors;
    m.genres = dto.genres;
    m.anime = dto.anime;
    m.categories = dto.categories;
    return m;
  }
}
