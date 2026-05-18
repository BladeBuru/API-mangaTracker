import User from '@/api/user/user.entity';
import { Manga } from '@/api/mangas/manga.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * Groupe de "lecture à deux" (Phase 8 — skeleton).
 *
 * Un groupe = N users (typiquement 2) qui partagent la progression sur
 * un même manga. La sync s'appuie sur le polling (30s) côté client pour
 * MVP — websockets plus tard si la latence devient un problème.
 *
 * `owner` = créateur du groupe (peut inviter/exclure).
 */
@Entity('reading_group')
export class ReadingGroup {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'owner_id' })
  owner: User;

  @ManyToOne(() => Manga, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'manga_id', referencedColumnName: 'mu_id' })
  manga: Manga;

  @Column({ type: 'varchar', length: 80, nullable: true })
  name: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @OneToMany(() => ReadingGroupMember, (m) => m.group)
  members: ReadingGroupMember[];
}

/**
 * Membre d'un groupe de lecture. Unicité (group, user) pour empêcher
 * les doublons d'invitation.
 */
@Entity('reading_group_member')
@Unique('UQ_reading_group_member_group_user', ['group', 'user'])
export class ReadingGroupMember {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => ReadingGroup, (g) => g.members, {
    onDelete: 'CASCADE',
    nullable: false,
  })
  @JoinColumn({ name: 'group_id' })
  group: ReadingGroup;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @CreateDateColumn({ type: 'timestamp' })
  joinedAt: Date;
}
