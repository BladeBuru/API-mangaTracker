import {Column, Entity, OneToMany, PrimaryGeneratedColumn} from 'typeorm';
import {Exclude} from "class-transformer";
import {UserFavoriteManga} from "@/api/user/userFavoris.entity";


@Entity()
class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  username: string;

  @Column()
  email: string;

  @Exclude()
  @Column()
  password!: string;

  @Column({ type: 'timestamp', nullable: true, default: null })
  public lastLoginAt: Date | null;

  @OneToMany(() => UserFavoriteManga, (userFavoriteManga) => userFavoriteManga.user)
  favoriteMangas: UserFavoriteManga[];
}
export default User;
