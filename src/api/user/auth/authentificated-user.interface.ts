import { Column, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { UserMangaFavorite } from '@/api/favorites/user-manga-favorite.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';

export interface AuthenticatedUser {
  id: number;

  username: string;

  email: string;

  password: string;

  favoriteMangas: UserMangaFavorite[];

  userMangas: UserManga[];

  lastLoginAt: Date | null;
}
