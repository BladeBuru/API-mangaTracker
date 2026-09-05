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
 * Jobs à nom FIXE, sélectionnables un par un via `CatalogSyncService.runOnce`.
 * - `catalog:rating`   : passe globale (orderby=rating).
 * - `catalog:week_pos` : passe hebdomadaire du dimanche (orderby=week_pos).
 * - `hydration`        : hydratation des lignes `manga` incomplètes (genres,
 *                        rating, année, cover OU titres alternatifs manquants)
 *                        via getMangaDetails.
 * - `releases`         : flux des dernières sorties de chapitres
 *                        (`CatalogReleasesService`). Seul job à ne PAS
 *                        paginer un catalogue : son curseur est temporel
 *                        (`cursor_time_added`), pas une page.
 *
 * La table contient AUSSI des lignes à nom dynamique, une par shard de
 * catalogue, non énumérables ici : `catalog:year:<AAAA>`,
 * `catalog:year:<AAAA>:genre:<Genre>` et, pour le rattrapage de
 * `manga.type` (`CatalogTypeBackfillService`), `type:<Type>:year:<AAAA>`
 * (cf. `catalog-shard.ts`). C'est pourquoi la colonne `job_name` reste un
 * `string` libre.
 */
export type CatalogSyncJobName =
  | 'catalog:rating'
  | 'catalog:week_pos'
  | 'hydration'
  | 'releases';

/**
 * Jobs réellement orchestrés par `CatalogSyncService.runOnce`. `releases` en
 * est exclu : il a son propre cron (02:00) et son propre curseur temporel,
 * porté par `CatalogReleasesService`. Le type empêche de l'y passer par
 * erreur — il n'a pas de shard à construire.
 */
export type CatalogSyncRunnableJob = Exclude<CatalogSyncJobName, 'releases'>;

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

  /**
   * Date de la dernière complétion INTÉGRALE du shard (dernière page
   * atteinte). `null` = jamais terminé, ou parcours en cours.
   *
   * C'est le pivot de la reprise inter-shards : le planificateur exclut de la
   * file les shards dont la complétion est plus récente que leur fenêtre de
   * rafraîchissement. Distinct de `last_run_at`, qui est horodaté à CHAQUE
   * run, complet ou non, et ne peut donc pas servir à décider d'une reprise.
   */
  @Column({ type: 'timestamptz', nullable: true })
  completed_at: Date | null;

  /**
   * `true` quand la requête du shard atteint le plafond `total_hits` de MU
   * (10 000) : la réponse est tronquée, le shard doit être sous-découpé par
   * genre pour rester exhaustif.
   */
  @Column({ default: false })
  saturated: boolean;

  /** Dernier `total_hits` observé — diagnostic et détection de saturation. */
  @Column({ type: 'int', nullable: true })
  total_hits: number | null;

  /**
   * Curseur **temporel** du job `releases` : plus grand `time_added.timestamp`
   * (epoch secondes) déjà traité. `null` = jamais tourné → le job se rabat sur
   * une fenêtre de rattrapage bornée (`RELEASES_SYNC_LOOKBACK_DAYS`).
   *
   * `bigint` (donc exposé en `string` par TypeORM) plutôt que `int` : un epoch
   * secondes dépasse `int4` en 2038, et réutiliser `last_completed_page` pour
   * y loger un horodatage aurait mélangé deux sémantiques dans une colonne
   * dont le nom promet une page.
   *
   * N'a de sens QUE pour la ligne `releases` — NULL partout ailleurs.
   * Migration `1788048000000`.
   */
  @Column({ type: 'bigint', nullable: true })
  cursor_time_added: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
