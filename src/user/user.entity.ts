import { UserManga } from 'src/mangas/user-manga.entity';
import { Manga } from 'src/mangas/manga.entity';
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
}
export default User;
