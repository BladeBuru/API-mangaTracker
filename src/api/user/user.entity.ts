import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import {Exclude} from "class-transformer";

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
}
export default User;
