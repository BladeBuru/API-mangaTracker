import { Manga } from 'src/mangas/manga.entity';
import {
  Column,
  Entity,
  JoinTable,
  ManyToMany,
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
  library: Manga[];

  @ManyToMany(() => Manga)
  @JoinTable()
  favorites: Manga[];
}
export default User;
