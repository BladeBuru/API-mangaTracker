import User from 'src/user/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Manga } from './manga.entity';

@Entity()
export class UserManga {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (user) => user.userMangas)
  user: User;

  @ManyToOne(() => Manga, (manga) => manga.userMangas)
  manga: Manga;

  @CreateDateColumn()
  addingDate: Date;

  @Column({ default: 0 })
  userRating: number;

  @Column({ default: 0 })
  userReadChapters: number;
}
