import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Issue d'une tentative d'extraction pour un lecteur.
 * - `collected` : au moins une liste publique lue et ingérée ;
 * - `empty`     : aucune liste publique (compte fermé ou listes privées) —
 *                 état NORMAL, pas une erreur : on ne réessaiera qu'après la
 *                 fenêtre de rafraîchissement, sinon on brûlerait le budget
 *                 chaque nuit sur les mêmes comptes muets ;
 * - `failed`    : échec réseau MU après backoff.
 */
export type ReaderProfileStatus = 'collected' | 'empty' | 'failed';

/**
 * Journal d'extraction par lecteur pseudonymisé.
 *
 * Sert **uniquement** à ne pas re-collecter un lecteur déjà vu récemment
 * (`READER_SIGNAL_READER_TTL_DAYS`) : sans cette table, le job repasserait
 * chaque nuit sur les mêmes comptes — ce sont toujours les 100 plus anciens
 * `user_id` que `/lists/similar` renvoie — et ne découvrirait jamais rien.
 *
 * ## RGPD
 *
 * Ne contient **que** le hash salé et des compteurs. Aucun `user_id` en
 * clair, aucun pseudo, aucune URL : mêmes garanties que `ReaderSignal`, dont
 * elle partage le cycle de vie (purgée avec les lignes brutes, cf.
 * `ReaderSignalAggregateService.purgeRawSignal`).
 *
 * Le `user_id` MangaUpdates en clair n'existe QUE dans la mémoire du run en
 * cours : la découverte le hache immédiatement pour interroger cette table,
 * l'extraction réutilise la valeur brute encore en mémoire, et le run se
 * termine sans l'avoir écrite nulle part. C'est aussi pourquoi les deux
 * étages sont couplés dans un même run : il ne peut pas exister de file
 * d'attente de lecteurs persistée entre deux nuits.
 */
@Entity('reader_profile')
// Sélection « qui est périmé ? » en tête de chaque run.
@Index('IDX_reader_profile_last_collected', ['last_collected_at'])
export class ReaderProfile {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** HMAC-SHA256(sel, user_id MU), hexadécimal minuscule. */
  @Column({ type: 'char', length: 64, unique: true })
  user_hash: string;

  /** Dernière extraction TENTÉE (réussie, vide ou en échec). */
  @Column({ type: 'timestamptz', nullable: true })
  last_collected_at: Date | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  status: ReaderProfileStatus | null;

  /** Listes publiques vues à la dernière extraction. */
  @Column({ type: 'int', default: 0 })
  list_count: number;

  /** Lignes `reader_signal` écrites à la dernière extraction. */
  @Column({ type: 'int', default: 0 })
  row_count: number;

  /** Échecs consécutifs — au-delà du seuil, le lecteur est mis de côté. */
  @Column({ type: 'int', default: 0 })
  failure_count: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
