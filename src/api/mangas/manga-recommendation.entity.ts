import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('manga_recommendation')
@Index(['source_mu_id', 'recommended_mu_id'], { unique: true })
export class MangaRecommendation {
  @PrimaryGeneratedColumn()
  id: number;

  /** mu_id du manga source (celui qui est dans la bibliothèque) */
  @Column({ type: 'bigint' })
  source_mu_id: string;

  /** mu_id du manga recommandé */
  @Column({ type: 'bigint' })
  recommended_mu_id: string;

  /** Titre du manga recommandé (stocké pour éviter un JOIN systématique) */
  @Column({ type: 'varchar', nullable: true })
  recommended_title: string | null;

  /** Poids de la recommandation selon MangaUpdates (échelle 1-10) */
  @Column({ type: 'int' })
  weight: number;

  @UpdateDateColumn()
  updated_at: Date;
}
