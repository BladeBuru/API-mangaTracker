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
 * Partage de manga entre amis (Phase 8).
 *
 * Une ligne par event "user A a recommandé manga X à user B".
 * `seenAt` permet d'afficher un badge "Nouveau" tant que l'addressee
 * n'a pas ouvert la notification. `message` optionnel : commentaire libre
 * de l'expéditeur ("Tu vas adorer, regarde dès que possible !").
 */
@Entity('manga_share')
@Index(['addressee', 'seenAt'])
export class MangaShare {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'sender_id' })
  sender: User;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'addressee_id' })
  addressee: User;

  @ManyToOne(() => Manga, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'manga_id', referencedColumnName: 'mu_id' })
  manga: Manga;

  @Column({ type: 'varchar', length: 280, nullable: true, default: null })
  message: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  /** Null = jamais ouvert par l'addressee. Set au premier GET côté UI. */
  @Column({ type: 'timestamp', nullable: true, default: null })
  seenAt: Date | null;
}
