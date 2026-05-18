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
  UpdateDateColumn,
} from 'typeorm';

/**
 * Commentaire sur un manga (Phase 7).
 *
 * - Supporte le threading : `parentComment` non-null = réponse.
 * - `isDeleted` (soft delete) : l'auteur ou un admin peut supprimer ;
 *   l'UI affiche "[supprimé]" mais conserve la structure pour ne pas
 *   casser les threads de réponses.
 * - `rating` optionnel : note 1-10 attachée au commentaire (review).
 */
@Entity('manga_comment')
@Index(['manga', 'createdAt'])
@Index(['parentComment'])
export class MangaComment {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Manga, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'manga_id', referencedColumnName: 'mu_id' })
  manga: Manga;

  /**
   * Référence au commentaire parent pour les réponses. Null = top-level.
   * Cascade DELETE → si un commentaire parent est hard-deleté, ses
   * réponses le sont aussi (admin only).
   */
  @ManyToOne(() => MangaComment, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'parent_comment_id' })
  parentComment: MangaComment | null;

  @Column({ type: 'text' })
  content: string;

  /** Note 1-10 attachée (review). Null = pas une review. */
  @Column({ type: 'int', nullable: true, default: null })
  rating: number | null;

  /**
   * Soft delete : true = "[supprimé]" affiché côté UI, le contenu n'est
   * pas effacé physiquement pour les enquêtes de modération. Hard delete
   * uniquement par admin.
   */
  @Column({ type: 'boolean', default: false })
  isDeleted: boolean;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;
}
