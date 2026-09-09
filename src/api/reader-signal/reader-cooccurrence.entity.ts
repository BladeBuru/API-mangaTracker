import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Co-occurrence œuvre↔œuvre calculée depuis `reader_signal`.
 *
 * « Ces deux titres reviennent souvent chez les mêmes lecteurs » — c'est ce
 * qui sert réellement à recommander, et **cette table ne contient plus aucune
 * notion de lecteur**. C'est le point d'arrivée du chemin de conformité :
 * une fois ces agrégats calculés, les lignes brutes peuvent être purgées et
 * il ne reste que des statistiques sur des œuvres, hors du champ des données
 * personnelles.
 *
 * ## Symétrie
 *
 * Le score est symétrique (cosinus), mais **les deux sens sont stockés**
 * (`(a,b)` ET `(b,a)`). Deux fois plus de lignes, contre une lecture
 * indexée triviale côté moteur :
 *
 * ```sql
 * SELECT mu_id_b, score FROM reader_cooccurrence
 * WHERE mu_id_a = $1 ORDER BY score DESC LIMIT 20;
 * ```
 *
 * Un stockage canonique `a < b` aurait imposé un `OR` (ou un `UNION`) à
 * chaque lecture, sur le chemin chaud des recommandations.
 */
@Entity('reader_cooccurrence')
@Index('UQ_reader_cooccurrence_pair', ['mu_id_a', 'mu_id_b'], { unique: true })
// Chemin de lecture du moteur : meilleures voisines d'une œuvre.
@Index('IDX_reader_cooccurrence_a_score', ['mu_id_a', 'score'])
export class ReaderCooccurrence {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** Œuvre de référence (`manga.mu_id`). */
  @Column({ type: 'bigint' })
  mu_id_a: string;

  /** Œuvre voisine (`manga.mu_id`). */
  @Column({ type: 'bigint' })
  mu_id_b: string;

  /**
   * Nombre de lecteurs ayant les DEUX œuvres dans leur signal, tous types de
   * liste confondus. Indicateur de **confiance**, indépendant du score : un
   * score de 0,9 sur 3 lecteurs ne vaut pas un 0,6 sur 400.
   */
  @Column({ type: 'int' })
  co_readers: number;

  /**
   * Somme brute des contributions `affinité(a) × affinité(b)` sur les
   * lecteurs communs. Non normalisée : croît mécaniquement avec la
   * popularité. Conservée pour le diagnostic et pour permettre au moteur de
   * re-normaliser autrement sans repasser par les lignes brutes.
   */
  @Column({ type: 'double precision' })
  weight: number;

  /**
   * Similarité cosinus dans `[-1, 1]` : `weight / (‖A‖ × ‖B‖)`.
   *
   * Négatif = signal de RÉPULSION (« les lecteurs qui aiment A abandonnent
   * B »), exploitable tel quel comme malus. C'est l'information qui manque
   * totalement au produit aujourd'hui.
   */
  @Column({ type: 'double precision' })
  score: number;

  /** Fin du run d'agrégation ayant produit la ligne. */
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  computed_at: Date;
}
