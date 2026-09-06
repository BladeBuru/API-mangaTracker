import User from 'src/api/user/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Manga } from './manga.entity';
import { ReadingStatus } from '@/api/library/reading-status.enum';

@Entity('user_manga')
export class UserManga {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (user) => user.user_mangas, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Manga, (manga) => manga.user_mangas, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'manga_id', referencedColumnName: 'mu_id' })
  manga: Manga;

  @CreateDateColumn()
  adding_date: Date;

  @Column({ default: 0 })
  user_rating: number;

  @Column({ default: 0 })
  user_read_chapters: number;

  @Column({ nullable: false, default: ReadingStatus.ReadLater })
  public readingStatus: string;

  @Column({ type: 'timestamp', nullable: true, default: null })
  public lastUpdated: Date | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  custom_link: string | null;

  // ─────── Reprise de lecture inter-appareils (2026-09) ───────
  // État « lecture EN COURS », singleton par (user, manga). À NE PAS
  // confondre avec `user_read_chapters`, qui est le dernier chapitre
  // TERMINÉ : on peut avoir terminé 12 chapitres ET être à 40 % du 13e.
  // Les trois colonnes vont toujours ensemble (toutes nulles ou toutes
  // renseignées) — cf. migration 1788393600000.

  /** Chapitre en cours de lecture. NULL = aucune lecture en cours. */
  @Column({
    name: 'current_chapter',
    type: 'int',
    nullable: true,
    default: null,
  })
  currentChapter: number | null;

  /**
   * Avancement DANS `currentChapter`, en pourcentage (0-100).
   * Un pourcentage et non des pixels : la hauteur rendue d'un chapitre
   * dépend de l'écran, seul un ratio se transporte d'un appareil à l'autre.
   */
  @Column({
    name: 'current_position_percent',
    type: 'smallint',
    nullable: true,
    default: null,
  })
  currentPositionPercent: number | null;

  /** Horodatage serveur de la dernière écriture de position acceptée. */
  @Column({
    name: 'current_position_updated_at',
    type: 'timestamptz',
    nullable: true,
    default: null,
  })
  currentPositionUpdatedAt: Date | null;
}
