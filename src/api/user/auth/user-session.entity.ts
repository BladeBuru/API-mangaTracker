import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import User from '../user.entity';

@Entity('user_session')
export class UserSession {
  @PrimaryColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: number;

  /** Identifiant de l'appareil (user-agent, nom de l'app, etc.) */
  @Column({ nullable: true, type: 'varchar' })
  deviceInfo: string | null;

  @CreateDateColumn()
  createdAt: Date;

  /**
   * Date à laquelle ce refresh token a été échangé contre un nouveau.
   * La ligne n'est plus supprimée sur-le-champ : rejouée dans le délai de
   * grâce (réponse perdue, requêtes simultanées), elle redonne la session
   * qui l'a remplacée au lieu de déconnecter l'appareil.
   */
  @Column({ name: 'rotated_at', type: 'timestamptz', nullable: true })
  rotatedAt: Date | null;

  /** Session qui a remplacé celle-ci lors de l'échange. */
  @Column({ name: 'replaced_by_id', type: 'uuid', nullable: true })
  replacedById: string | null;
}
