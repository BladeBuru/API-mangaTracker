import { UserManga } from 'src/api/mangas/user-manga.entity';
import { UserSession } from 'src/api/user/auth/user-session.entity';
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

export enum AuthProvider {
  LOCAL = 'local',
  GOOGLE = 'google',
}

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  username: string;

  @Column()
  email: string;

  @Column({ nullable: true })
  password: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  googleId: string | null;

  @Column({
    type: 'varchar',
    default: AuthProvider.LOCAL,
  })
  authProvider: AuthProvider;

  @OneToMany(() => UserManga, (userManga) => userManga.user)
  user_mangas: UserManga[];

  @OneToMany(() => UserSession, (session) => session.user)
  sessions: UserSession[];

  @Column({ type: 'timestamp', nullable: true, default: null })
  public lastLoginAt: Date | null;

  /**
   * Timestamp de vérification de l'email via magic link.
   * Null = email non vérifié (banner dans l'app, certaines actions bloquées).
   * Set automatiquement par `EmailService.verifyEmail()` après validation
   * du token reçu par mail.
   */
  @Column({ type: 'timestamp', nullable: true, default: null })
  public emailVerifiedAt: Date | null;

  // ─────── RGPD : traçabilité du consentement ───────

  /**
   * Timestamp d'acceptation des Conditions Générales d'Utilisation.
   * Null = jamais accepté (compte créé avant l'introduction du flag).
   * Permet de prouver le consentement éclairé en cas de litige.
   */
  @Column({ type: 'timestamp', nullable: true, default: null })
  public acceptedTosAt: Date | null;

  /**
   * Version des CGU acceptées (ex: "1.0"). Permet de redemander le
   * consentement après un changement majeur des CGU.
   */
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  public acceptedTosVersion: string | null;

  /** Timestamp d'acceptation de la Politique de confidentialité. */
  @Column({ type: 'timestamp', nullable: true, default: null })
  public acceptedPrivacyAt: Date | null;

  /** Version de la Politique de confidentialité acceptée. */
  @Column({ type: 'varchar', length: 16, nullable: true, default: null })
  public acceptedPrivacyVersion: string | null;
}

export default User;
