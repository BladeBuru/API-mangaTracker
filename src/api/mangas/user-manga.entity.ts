import User from 'src/api/user/user.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Manga } from './manga.entity';

@Entity('user_manga')
export class UserManga {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (user) => user.user_mangas)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Manga, (manga) => manga.user_mangas)
  @JoinColumn({ name: 'manga_id', referencedColumnName: 'mu_id' })
  manga: Manga;

  @CreateDateColumn()
  adding_date: Date;

  @Column({ default: 0 })
  user_rating: number;

  @Column({ default: 0 })
  user_read_chapters: number;
}
