import { UserManga } from 'src/api/mangas/user-manga.entity';
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  username: string;

  @Column()
  email: string;

  @Column()
  password: string;

  @OneToMany(() => UserManga, (userManga) => userManga.user)
  user_mangas: UserManga[];

  @Column({ type: 'timestamp', nullable: true, default: null })
  public lastLoginAt: Date | null;
}

export default User;
