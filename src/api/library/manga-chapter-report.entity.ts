import User from '@/api/user/user.entity';
import { Manga } from '@/api/mangas/manga.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Signalement « ce manga a plus de chapitres que le total connu » (Chantier A).
 *
 * La ligne EST l'override par user : le total effectif d'un user est
 * `max(manga.total_chapters, reported_total)`. Pas de colonne override sur
 * `manga` — le cap 406 reste en place (garde-fou anti-typo) mais s'applique
 * au total effectif, borné à `total + MAX_REPORT_DELTA`.
 *
 * Consolidation communautaire : quand ≥ MIN_REPORTERS users distincts
 * signalent un total > total officiel, `manga.total_chapters` est bumpé au
 * MIN des totaux signalés concordants, puis les reports couverts sont purgés
 * (voir `ChapterReportService.consolidate`).
 *
 * Contrainte d'unicité (user, manga) : un user n'a qu'un report actif par
 * manga — un nouveau report écrase le précédent (upsert).
 */
@Entity('manga_chapter_report')
@Unique('UQ_chapter_report_user_manga', ['user', 'manga'])
export class MangaChapterReport {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Manga, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'manga_id', referencedColumnName: 'mu_id' })
  manga: Manga;

  /** Total de chapitres signalé par l'user (strictement > total officiel). */
  @Column({ type: 'int', nullable: false })
  reported_total: number;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;
}
