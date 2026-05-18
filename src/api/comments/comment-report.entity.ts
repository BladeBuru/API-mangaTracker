import User from '@/api/user/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { MangaComment } from './manga-comment.entity';

/**
 * Skeleton de modération (Phase 7).
 *
 * Un user peut signaler un commentaire ; l'agrégation côté admin (file
 * d'attente de modération, actions automatiques sur seuil) sera ajoutée
 * dans une phase ultérieure. Pour MVP, on stocke juste le report.
 *
 * Contrainte d'unicité (user, comment) : un user ne peut signaler qu'une
 * fois le même commentaire.
 */
@Entity('comment_report')
@Unique('UQ_comment_report_user_comment', ['user', 'comment'])
export class CommentReport {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => MangaComment, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'comment_id' })
  comment: MangaComment;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reason: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;
}
