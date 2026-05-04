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
}
