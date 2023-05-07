import { UserManga } from 'src/api/mangas/user-manga.entity';
import { Manga } from 'src/api/mangas/manga.entity';
import {
  Column,
  Entity,
  JoinTable,
  ManyToMany,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';

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

  @ManyToMany(() => Manga)
  @JoinTable()
  favorites: Manga[];

  @OneToMany(() => UserManga, (userManga) => userManga.user)
  userMangas: UserManga[];

  @Column({ type: 'timestamp', nullable: true, default: null })
  public lastLoginAt: Date | null;
}
export default User;
