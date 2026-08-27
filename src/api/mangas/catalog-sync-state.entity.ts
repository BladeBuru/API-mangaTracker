import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Statuts possibles d'un run de synchronisation catalogue.
 * - `completed` : la passe a atteint sa dernière page (curseur remis à 0).
 * - `partial`   : arrêt propre en cours de passe (budget épuisé ou échec MU
 *                 persistant) — le curseur est conservé pour reprise.
 * - `failed`    : réservé aux erreurs fatales inattendues.
 */
export type CatalogSyncRunStatus = 'completed' | 'partial' | 'failed';

/**
 * Jobs suivis :
 * - `catalog:rating`   : passe principale nightly (orderby=rating).
 * - `catalog:week_pos` : passe hebdomadaire du dimanche (orderby=week_pos).
 * - `hydration`        : hydratation des genres manquants via getMangaDetails.
 */
export type CatalogSyncJobName =
  | 'catalog:rating'
  | 'catalog:week_pos'
  | 'hydration';

/**
 * Curseur persistant de la synchronisation nightly du catalogue MangaUpdates
 * (CatalogSyncService). Une ligne par job — permet la reprise après un arrêt
 * partiel (rate-limit MU, redémarrage du process) sans re-parcourir les pages
 * déjà ingérées.
 */
@Entity('catalog_sync_state')
export class CatalogSyncState {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  job_name: string;

  /** Dernière page MU ingérée avec succès (0 = passe pas commencée). */
  @Column({ default: 0 })
  last_completed_page: number;

  /** Nombre total de pages de la passe (connu après la 1ʳᵉ réponse MU). */
  @Column({ type: 'int', nullable: true })
  total_pages: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_run_at: Date | null;

  @Column({ type: 'varchar', nullable: true })
  last_run_status: CatalogSyncRunStatus | null;

  /** Nombre d'échecs consécutifs (remis à 0 sur passe complétée). */
  @Column({ default: 0 })
  consecutive_failures: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
