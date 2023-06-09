import { UserManga } from 'src/api/mangas/user-manga.entity';
import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { UserMangaFavorite } from '@/api/favorites/user-manga-favorite.entity';

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

  @OneToMany(
    () => UserMangaFavorite,
    (userFavoriteManga) => userFavoriteManga.user,
  )
  favoriteMangas: UserMangaFavorite[];

  @OneToMany(() => UserManga, (userManga) => userManga.user)
  user_mangas: UserManga[];

  @Column({ type: 'timestamp', nullable: true, default: null })
  public lastLoginAt: Date | null;
}
export default User;
