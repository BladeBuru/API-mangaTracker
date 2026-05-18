import User from '@/api/user/user.entity';
import { Manga } from '@/api/mangas/manga.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Log additif des sessions de lecture d'un chapitre (Phase 5).
 *
 * **Pourquoi cette table** : `user_manga.user_read_chapters` est un pointeur
 * "j'en suis là", monotone. Il ne capture pas :
 *   - les replays (relire un chapitre)
 *   - les hors-séries (chapitre bonus à compter à part)
 *   - les skips volontaires (sauter un chapitre filler sans bouger le pointeur)
 *   - la position de scroll pour la reprise de lecture
 *
 * Cette table est purement additive : une ligne par session de lecture.
 * `user_read_chapters` reste la source de vérité pour la progression
 * globale ; le log enrichit les stats sans casser la compatibilité.
 *
 * Plusieurs lignes peuvent exister pour le même `(user, manga, chapter)` :
 *   - 1 ligne avec `is_skipped = true` → l'user a marqué ce chapitre comme
 *     ignoré (compté à part dans les stats, non comptabilisé dans le temps
 *     de lecture)
 *   - N lignes avec `is_skipped = false` → N sessions de lecture (replays)
 */
@Entity('user_manga_chapter_log')
@Index(['user', 'manga', 'chapterNumber'])
export class UserMangaChapterLog {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Manga, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'manga_id', referencedColumnName: 'mu_id' })
  manga: Manga;

  /** Numéro de chapitre (peut être décimal pour les chap 12.5 etc.) */
  @Column({ type: 'decimal', precision: 8, scale: 2 })
  chapterNumber: number;

  /**
   * `true` si l'user a marqué ce chapitre comme volontairement skippé
   * (hors-série non intéressant, recap, etc.). Le chapitre n'est pas
   * comptabilisé dans le temps de lecture mais l'event est tracé pour
   * pouvoir le "ré-activer" si l'user change d'avis.
   */
  @Column({ type: 'boolean', default: false })
  isSkipped: boolean;

  /**
   * `true` si ce chapitre est un hors-série / bonus (numéroté à part
   * dans la série, ex: chapitres OAV, omake). Permet d'afficher
   * "X chapitres lus dont Y bonus" dans les stats.
   */
  @Column({ type: 'boolean', default: false })
  isBonus: boolean;

  /**
   * Position de scroll dans le webview au moment du dernier `read_at`.
   * Null = chapitre terminé (scroll en bas). Sinon = reprise possible.
   */
  @Column({ type: 'int', nullable: true, default: null })
  scrollPosition: number | null;

  @CreateDateColumn({ type: 'timestamp' })
  readAt: Date;
}
