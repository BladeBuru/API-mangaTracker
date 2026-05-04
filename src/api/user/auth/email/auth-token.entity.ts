import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import User from '@/api/user/user.entity';

/**
 * Type de token à usage unique pour les actions sensibles déclenchées par
 * email (confirmation, reset password). Volontairement séparé des sessions
 * `UserSession` pour ne pas mélanger les durées de vie ni les surfaces
 * d'attaque.
 */
export enum AuthTokenType {
  EmailVerify = 'email_verify',
  PasswordReset = 'password_reset',
}

/**
 * Token à usage unique stocké hashé en base.
 *
 * Sécurité (best practices OWASP) :
 *  - Le token brut (envoyé dans l'email) n'est JAMAIS stocké : seul son
 *    hash SHA-256 l'est. En cas de fuite DB, les tokens ne sont pas
 *    réutilisables.
 *  - `usedAt` marque la consommation : un token ne peut être validé
 *    qu'une seule fois (anti-replay).
 *  - `expiresAt` court (60 min verify, 30 min reset) limite la fenêtre
 *    d'attaque.
 *  - Index sur `tokenHash` pour le lookup en O(1).
 *  - Index sur `(user, type)` pour la révocation en cascade lors de la
 *    consommation d'un nouveau token (ex: nouveau reset → on invalide
 *    les anciens du même type).
 */
@Entity('auth_token')
@Index(['tokenHash'], { unique: true })
@Index(['user', 'type'])
export class AuthToken {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'user_id' })
  userId: number;

  /** SHA-256 hex du token brut. 64 caractères. */
  @Column({ type: 'varchar', length: 64 })
  tokenHash: string;

  @Column({
    type: 'varchar',
    length: 32,
  })
  type: AuthTokenType;

  /** Expiration absolue. Lookup ignore les tokens expirés. */
  @Column({ type: 'timestamp' })
  expiresAt: Date;

  /** Null = pas encore consommé. Set à `now()` lors du `verifyAndConsume`. */
  @Column({ type: 'timestamp', nullable: true, default: null })
  usedAt: Date | null;

  /** IP du client lors de la création — audit en cas d'incident. */
  @Column({ type: 'varchar', length: 45, nullable: true })
  createdIp: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
