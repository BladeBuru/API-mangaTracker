import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
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
}
export default User;
