import User from '@/api/user/user.entity';
import { Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Manga } from '../mangas/manga.entity';

@Entity()
export class UserMangaFavorite {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (user) => user.userMangas)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Manga, (manga) => manga.favoriteMangas)
  @JoinColumn({ name: 'manga_id' })
  manga: Manga;
}
