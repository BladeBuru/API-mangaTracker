import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { READER_LIST_TYPE_MAX_LENGTH } from './reader-signal-weights';

/**
 * Signal de lecture public MangaUpdates, **anonymisé à l'ingestion**.
 *
 * Une ligne = « un lecteur (pseudonymisé) a rangé telle œuvre dans telle
 * liste, éventuellement avec telle note ». C'est la matière première du
 * filtrage collaboratif : la base ne contient que 4 notes utilisateur pour
 * 6 comptes, aucun moteur de recommandation ne peut fonctionner là-dessus.
 *
 * ## RGPD — ce que cette table ne contient PAS, par construction
 *
 * Une liste de lecture est une donnée personnelle, et elle peut révéler
 * indirectement des données sensibles (une liste majoritairement BL/yaoi
 * suggère une orientation sexuelle). Le caractère public de la liste ne vaut
 * ni consentement ni base légale. La table est donc conçue pour porter le
 * strict minimum :
 *
 * - **jamais** de `user_id` MangaUpdates en clair — seulement son HMAC-SHA256
 *   salé (`ReaderHashService`), calculé AVANT toute écriture ;
 * - **jamais** de `user_name`, d'URL de profil, ni aucun autre champ
 *   identifiant, alors même que l'API MU les renvoie (ils sont écartés dès
 *   le mapper, cf. `mu-lists.mapper.ts`) ;
 * - **jamais** de titre ni d'URL de série : `mu_id` suffit, la table `manga`
 *   porte déjà le reste.
 *
 * Le sel (`READER_SIGNAL_HASH_SALT`) n'est pas versionné et ne quitte jamais
 * l'environnement d'exécution : sans lui, les `user_hash` ne sont pas
 * réversibles vers des comptes MangaUpdates.
 *
 * ## Cycle de vie
 *
 * Ces lignes brutes sont un INTERMÉDIAIRE de calcul. Ce qui sert réellement
 * à recommander, ce sont les co-occurrences œuvre↔œuvre
 * (`ReaderCooccurrence`), qui ne portent plus aucune notion de lecteur.
 * Une fois les agrégats calculés, la table peut être purgée
 * (`ReaderSignalAggregateService.purgeRawSignal`, `READER_SIGNAL_RAW_TTL_DAYS`) —
 * c'est ce qui permet de sortir durablement du champ des données
 * personnelles. Voir `.claude/memory-bank/decisions.md`.
 */
@Entity('reader_signal')
// Unicité métier : un lecteur ne range une œuvre qu'une fois par type de
// liste. Support de l'upsert `ON CONFLICT DO UPDATE` → l'ingestion est
// idempotente, un même lecteur re-collecté n'accumule pas de doublons.
@Index(
  'UQ_reader_signal_reader_series_type',
  ['user_hash', 'mu_id', 'list_type'],
  {
    unique: true,
  },
)
// Chemin de l'agrégation : parcours par œuvre (jointure sur le focus set).
@Index('IDX_reader_signal_mu_id', ['mu_id'])
// Chemin de l'agrégation : auto-jointure par lecteur, et purge par lot.
@Index('IDX_reader_signal_reader', ['user_hash'])
export class ReaderSignal {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /**
   * HMAC-SHA256(sel, user_id MangaUpdates), en hexadécimal minuscule
   * (64 caractères). **Seule** trace du lecteur.
   */
  @Column({ type: 'char', length: 64 })
  user_hash: string;

  /**
   * `series_id` MangaUpdates — identique à `manga.mu_id` : aucune jointure
   * de correspondance à faire, c'est ce qui rend cette source exploitable.
   *
   * Pas de clé étrangère vers `manga` : le job n'ingère que des séries déjà
   * connues (même doctrine que `CatalogReleasesService` — jamais de création
   * depuis un flux secondaire), mais une purge du catalogue ne doit pas
   * pouvoir supprimer en cascade du signal déjà agrégé.
   */
  @Column({ type: 'bigint' })
  mu_id: string;

  /** `complete` | `read` | `wish` | `unfinished` | `hold`. */
  @Column({ type: 'varchar', length: READER_LIST_TYPE_MAX_LENGTH })
  list_type: string;

  /**
   * Note du lecteur sur l'échelle MU (1 → 10, pas de 0,1). `null` = non
   * notée, ou masquée par les options d'affichage de la liste
   * (`list.options.show_rating`) — les deux cas sont indiscernables et
   * traités pareil : la pondération retombe sur celle du type.
   */
  @Column({ type: 'numeric', precision: 4, scale: 2, nullable: true })
  rating: number | null;

  /** Horodatage de collecte — pilote la purge et la fenêtre de fraîcheur. */
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  collected_at: Date;
}
