import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Cache serveur des descriptions traduites (Chantier A — traduction des
 * descriptions côté serveur).
 *
 * Une ligne = "la description du manga `mu_id` traduite en `language`".
 * La décision de re-traduction est portée par `source_hash` (sha256 de la
 * description MU du jour) : la source n'est jamais persistée, elle est
 * refetchée live par `getMangaDetails` — tout changement de description
 * upstream invalide donc naturellement la traduction au hit suivant.
 *
 * Nom singulier assumé, cohérent avec le schéma existant (`manga`,
 * `manga_recommendation`, `user_manga`).
 */
@Entity('manga_translation')
@Index(['mu_id', 'language'], { unique: true })
export class MangaTranslation {
  @PrimaryGeneratedColumn()
  id: number;

  /** mu_id du manga (même convention bigint/string que manga_recommendation) */
  @Column({ type: 'bigint' })
  mu_id: string;

  /** Langue cible (code primaire 2 lettres : fr, de, es, pt, ja, ko) */
  @Column({ type: 'varchar', length: 5 })
  language: string;

  /** sha256 hex de la description source (anglaise) au moment de la traduction */
  @Column({ type: 'varchar', length: 64 })
  source_hash: string;

  /** Description traduite dans `language` */
  @Column({ type: 'text' })
  translated_description: string;

  /** Observabilité/debug uniquement — la re-traduction est pilotée par source_hash */
  @UpdateDateColumn()
  updated_at: Date;
}
