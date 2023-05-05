// user-favorite-manga.entity.ts

import { Entity, PrimaryGeneratedColumn, ManyToOne } from 'typeorm';
import User from "@/api/user/user.entity";
import {Manga} from "@/api/mangas/manga.entity";


@Entity()
export class UserFavoriteManga {
    @PrimaryGeneratedColumn()
    id: number;

    @ManyToOne(() => User, (user) => user.favoriteMangas)
    user: User;

    @ManyToOne(() => Manga, (manga) => manga.favoriteMangas)
    manga: Manga;
}
