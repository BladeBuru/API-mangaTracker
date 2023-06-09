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

@Entity()
export class UserManga {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (user) => user.userMangas, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Manga, (manga) => manga.userMangas, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'manga_id' })
  manga: Manga;

  @CreateDateColumn()
  addingDate: Date;

  @Column({ default: 0 })
  userRating: number;

  @Column({ default: 0 })
  userReadChapters: number;
}
