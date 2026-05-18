import { UserManga } from 'src/api/mangas/user-manga.entity';
import { UserSession } from 'src/api/user/auth/user-session.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum AuthProvider {
  LOCAL = 'local',
  GOOGLE = 'google',
}

/**
 * Genre déclaré par l'utilisateur (optionnel, Phase 3). Utilisé pour
 * stats démographiques agrégées. `preferNotToSay` est l'option par
 * défaut RGPD (privacy-by-default).
 */
export enum UserGender {
  Male = 'male',
  Female = 'female',
  NonBinary = 'non_binary',
  PreferNotToSay = 'prefer_not_to_say',
}

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Username unique case-insensitive. La contrainte d'unicité est
   * implémentée via un index unique sur `LOWER(username)` côté Postgres
   * (migration `1746231500000-AddUsernameUniqueIndex`) — sans ça `John`
   * et `john` pourraient coexister.
   *
   * Les lookups par username DOIVENT utiliser `ILike(...)` ou
   * `LOWER(...) = LOWER(...)` (cf. `FriendsService.searchUsers` et
   * `sendRequest`).
   */
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

  /**
   * Date de création du compte. Utilisé pour les statistiques utilisateur
   * (ancienneté, badge "membre depuis"). Migration 1746230900000.
   */
  @CreateDateColumn({ type: 'timestamp' })
  public createdAt: Date;

  // ─────── Phase 3 : Profil étendu ───────

  /**
   * URL de l'avatar utilisateur. Null = pas d'avatar (placeholder côté
   * client). Peut être une URL externe ou un chemin proxy vers
   * `/user/:id/avatar.jpg` une fois l'upload pipeline en place.
   */
  /**
   * URL d'avatar OU data URL base64 d'une image choisie depuis la galerie.
   *
   * **Types acceptés** :
   *  - URL externe : `https://cdn.../foo.jpg`
   *  - data URL : `data:image/jpeg;base64,/9j/4AAQ...` (image locale picker)
   *
   * Type `text` depuis `1746231600000` — `varchar(512)` était trop court
   * pour accommoder un base64 d'image (40-80 KB ≈ 60-80 K caractères).
   * Quand l'upload multipart sera câblé côté serveur (TODO multer + sharp
   * + volume NAS — voir progress.md), on stockera juste une URL
   * `/uploads/avatars/{userId}.jpg` et `text` reste largement assez.
   */
  @Column({ type: 'text', nullable: true, default: null })
  public avatarUrl: string | null;

  /**
   * Nom à afficher publiquement (commentaires, profil public). Distinct
   * du `username` (unique, immutable). Si null → fallback sur `username`.
   */
  @Column({ type: 'varchar', length: 80, nullable: true, default: null })
  public displayName: string | null;

  /**
   * Courte description (max 500 chars). Affichée sur le profil public si
   * `isProfilePublic = true`.
   */
  @Column({ type: 'varchar', length: 500, nullable: true, default: null })
  public bio: string | null;

  /**
   * Date de naissance — optionnelle, RGPD opt-in. Stockée pour stats
   * démographiques agrégées (jamais affichée publiquement).
   */
  @Column({ type: 'date', nullable: true, default: null })
  public dateOfBirth: Date | null;

  /**
   * Genre déclaré — optionnel, RGPD opt-in. Affiché uniquement si
   * `isProfilePublic = true` et que l'user a choisi autre chose que
   * `preferNotToSay`.
   */
  @Column({ type: 'varchar', length: 32, nullable: true, default: null })
  public gender: UserGender | null;

  /**
   * Opt-in profil public : si true, le profil est visible par les amis
   * (Phase 6) et `GET /user/profile/:id` retourne 200. Default false
   * (privacy-by-default RGPD).
   */
  @Column({ type: 'boolean', default: false })
  public isProfilePublic: boolean;
}

export default User;
