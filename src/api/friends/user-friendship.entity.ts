import User from '@/api/user/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * Statut d'une relation d'amitié (Phase 6).
 *
 * - `pending` : la demande a été envoyée, pas encore acceptée.
 * - `accepted` : amitié active des deux côtés.
 * - `blocked` : l'addressee a bloqué le requester (la relation reste en
 *   base pour empêcher les renvois de demandes, mais aucun contenu n'est
 *   partagé).
 */
export enum FriendshipStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Blocked = 'blocked',
}

/**
 * Relation d'amitié entre deux utilisateurs. Directionnelle au début
 * (requester → addressee), bidirectionnelle une fois acceptée (logique
 * applicative côté service : on cherche dans les deux colonnes).
 *
 * Contrainte d'unicité sur `(requester, addressee)` pour empêcher les
 * doublons de demandes. Le service vérifie aussi qu'il n'existe pas déjà
 * une relation inverse avant d'autoriser une nouvelle demande.
 */
@Entity('user_friendship')
@Unique('UQ_friendship_requester_addressee', ['requester', 'addressee'])
@Index(['addressee', 'status'])
@Index(['requester', 'status'])
export class UserFriendship {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'requester_id' })
  requester: User;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'addressee_id' })
  addressee: User;

  @Column({
    type: 'varchar',
    length: 16,
    default: FriendshipStatus.Pending,
  })
  status: FriendshipStatus;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true, default: null })
  acceptedAt: Date | null;
}
