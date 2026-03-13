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
}

export default User;
