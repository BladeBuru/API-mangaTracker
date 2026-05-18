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

  /**
   * URLs nullable depuis la migration 1746230800000 — un manga peut être
   * inséré comme "stub" (juste mu_id + title) lorsqu'on découvre un
   * candidat reco non encore en biblio d'un user. Les détails complets
   * (covers, rating, year) sont remplis lazy via `getMangaDetails` quand
   * le user clique dessus.
   */
  @Column({ nullable: true })
  small_cover_url: string | null;

  @Column({ nullable: true })
  medium_cover_url: string | null;

  @Column({ type: 'bigint', unique: true })
  mu_id: string;

  @Column({ default: 0 })
  total_chapters: number;

  @Column('decimal', { precision: 3, scale: 2, nullable: true })
  rating: number | null;

  @Column({ nullable: true })
  year: number | null;

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

  /**
   * Construit une entité Manga depuis un MangaDetailsDto (post-`fromMU`).
   *
   * **Historique (2026-05-18)** : ce mapping utilisait avant des clés
   * snake_case en bracket-notation (`mangaDetailsDto['small_cover_url']`)
   * avec un fallback `?? mangaDetailsDto['smallCoverUrl']`. Le DTO déclare
   * ses propriétés en camelCase, donc la 1ʳᵉ branche était TOUJOURS
   * `undefined` — le fallback masquait le bug sans le réparer. Refactoré
   * pour lire directement les propriétés camelCase typées du DTO. Le
   * vrai bug sous-jacent (assignation snake_case côté `MangaDetailsDto.fromMU`)
   * a été corrigé dans le même commit.
   *
   * Les noms de propriétés de l'entité sont en snake_case parce que TypeORM
   * mappe directement nom-de-propriété → nom-de-colonne dans cette base.
   * On utilise donc le pattern `manga.small_cover_url = dto.smallCoverUrl`.
   */
  static fromMU(mangaDetailsDto: MangaDetailsDto): Manga {
    if (!mangaDetailsDto) {
      throw new Error('fromMU: mangaDetailsDto est undefined/null');
    }
    if (mangaDetailsDto.muId === undefined || mangaDetailsDto.muId === null) {
      throw new Error('fromMU: muId est manquant');
    }
    const manga = new Manga();
    manga.title = mangaDetailsDto.title;
    manga.year = mangaDetailsDto.year;
    manga.small_cover_url = mangaDetailsDto.smallCoverUrl;
    manga.medium_cover_url = mangaDetailsDto.mediumCoverUrl;
    manga.mu_id = mangaDetailsDto.muId.toString();
    manga.total_chapters = mangaDetailsDto.totalChapters;
    manga.rating = mangaDetailsDto.rating;
    manga.completed = mangaDetailsDto.completed;
    manga.associated = mangaDetailsDto.associated ?? [];
    // genres : MU les renvoie sous forme `[{genre: "Action"}, {genre: "Romance"}]`
    // ou parfois directement `["Action", ...]`. On normalise.
    const rawGenres = (mangaDetailsDto as any).genres ?? [];
    manga.genres = Array.isArray(rawGenres)
      ? rawGenres
          .map((g: any) =>
            typeof g === 'string' ? g : (g?.genre ?? g?.name ?? ''),
          )
          .filter((g: string) => g.length > 0)
      : null;
    return manga;
  }
}
