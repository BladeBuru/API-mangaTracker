import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class Manga {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  title: string;

  @Column()
  smallCoverUrl: string;

  @Column()
  mediumCoverUrl: string;

  @Column()
  muId: string;
}
