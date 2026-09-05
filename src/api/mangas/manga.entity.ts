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
import { normalizeGenres } from './genre.utils';

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

  /**
   * Type de publication MangaUpdates (`Manga`, `Manhwa`, `Manhua`, `Novel`,
   * `OEL`…) — cf. `manga-type.ts`. NULL = inconnu (ligne pas encore
   * revisitée par le catalogue ni rattrapée), jamais « pas de type ».
   *
   * Colonne protégée (`PROTECTED_NULLABLE_COLUMNS`) : on l'écrit quand MU la
   * fournit, on n'écrase jamais une valeur connue par null. Alimentée par
   * l'upsert catalogue (`record.type` du payload search), `getMangaDetails`
   * (`type` de la fiche) et `CatalogTypeBackfillService`. Migration
   * `1788220800000`.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  type: string | null;

  /**
   * Date de la dernière tentative d'hydratation par le job nightly
   * `hydration` (`CatalogSyncService.hydrateIncompleteRows`), qu'elle ait
   * réussi ou échoué.
   *
   * Garde anti-boucle : sans elle, un titre dont MU n'a réellement PAS de
   * note ni d'année resterait éligible chaque nuit et consommerait tout le
   * budget d'hydratation sur les mêmes lignes, indéfiniment. Une ligne
   * tentée n'est réessayée qu'après `HYDRATION_RETRY_AFTER_MS` (30 j), le
   * temps que MU ait pu publier la donnée manquante.
   *
   * NULL = jamais tentée → priorité maximale (cf. `ORDER BY ... NULLS FIRST`).
   * Colonne dédiée plutôt que `updated_at` : un stub fraîchement créé a un
   * `updated_at` récent et serait exclu 30 jours alors que c'est exactement
   * la ligne à réparer en priorité. Migration `1787875200000`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  hydration_attempted_at: Date | null;

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
    manga.type = mangaDetailsDto.type ?? null;
    manga.associated = mangaDetailsDto.associated ?? [];
    // genres : MU les renvoie sous forme `[{genre: "Action"}, {genre: "Romance"}]`
    // ou parfois directement `["Action", ...]`. Normalisation partagée.
    manga.genres = normalizeGenres((mangaDetailsDto as any).genres);
    return manga;
  }
}
