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
import {
  NOTIFICATION_TYPE_MAX_LENGTH,
  NotificationType,
} from './notification-type';

/**
 * Notification in-app unifiée (centre de notifications de l'app).
 *
 * Une ligne = un événement adressé à `user` : demande / acceptation
 * d'amitié, partage de manga, invitation à un groupe de lecture, nouveaux
 * chapitres. `actor` est l'utilisateur à l'origine de l'événement (NULL pour
 * les événements système comme les nouveaux chapitres, ou quand l'acteur a
 * supprimé son compte — FK `SET NULL`). `manga` est le titre concerné.
 *
 * Horodatages en millisecondes (`timestamptz(3)`) : la pagination par
 * curseur `before` renvoie `createdAt` au client en ISO 8601 (précision ms) ;
 * une colonne en microsecondes ferait sauter des lignes à la frontière.
 *
 * Migration `1788912000000-CreateNotification`.
 */
@Entity('notification')
@Index('IDX_notification_user_read_created', ['userId', 'readAt', 'createdAt'])
@Index('IDX_notification_actor', ['actorId'])
@Index('IDX_notification_mu_id', ['muId'])
// Au plus UNE notification « nouveaux chapitres » non lue par
// (utilisateur, manga) : les hausses successives la mettent à jour (upsert
// ensembliste, cf. `NotificationProducerService.newChapters`).
@Index('UQ_notification_new_chapters_unread', ['userId', 'muId'], {
  unique: true,
  where: `"type" = 'new_chapters' AND "read_at" IS NULL`,
})
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Destinataire. Cascade : la suppression du compte efface ses notifications. */
  @Column({ name: 'user_id', type: 'int' })
  userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'varchar', length: NOTIFICATION_TYPE_MAX_LENGTH })
  type: NotificationType;

  /** Utilisateur à l'origine de l'événement ; NULL = système ou compte supprimé. */
  @Column({ name: 'actor_id', type: 'int', nullable: true })
  actorId: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actor_id' })
  actor?: User | null;

  /** Manga concerné (`manga.mu_id`), NULL pour les événements d'amitié. */
  @Column({ name: 'mu_id', type: 'bigint', nullable: true })
  muId: string | null;

  @ManyToOne(() => Manga, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'mu_id', referencedColumnName: 'mu_id' })
  manga?: Manga | null;

  /** Données propres au type (identifiants, compteurs) — cf. `notification-type.ts`. */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  data: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
  createdAt: Date;

  /** NULL = non lue. */
  @Column({
    name: 'read_at',
    type: 'timestamptz',
    precision: 3,
    nullable: true,
    default: null,
  })
  readAt: Date | null;
}
