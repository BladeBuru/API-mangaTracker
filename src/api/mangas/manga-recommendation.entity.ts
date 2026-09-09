import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  RecoLinkKind,
  RECO_LINK_KIND_MAX_LENGTH,
  RELATION_TYPE_MAX_LENGTH,
} from './reco-graph.mapper';

/**
 * Arête du **graphe de voisinage œuvre-à-œuvre** de MangaUpdates : « la série
 * `source_mu_id` mène à `recommended_mu_id`, avec ce poids et par cette
 * origine ».
 *
 * ## Pourquoi une colonne `kind` et pas trois tables (2026-09-09)
 *
 * `GET /v1/series/{id}` expose trois voisinages (`recommendations`,
 * `category_recommendations`, `related_series` — cf. `reco-graph.mapper.ts`).
 * Ils partagent EXACTEMENT la même forme (source, cible, titre, poids) et les
 * mêmes consommateurs (moteur de recommandation, priorisation de
 * l'hydratation, section `hidden_gems` de l'accueil). Trois tables auraient
 * imposé un `UNION ALL` dans chaque lecture, trois upserts, trois index de
 * cible — pour zéro information supplémentaire. Un discriminant garde une
 * requête unique par source et laisse les 17 825 liens historiques en place,
 * marqués `manual` par la migration `1788480000000`.
 *
 * ## Unicité
 *
 * `(source_mu_id, kind, recommended_mu_id)` : une même paire source/cible peut
 * exister sous plusieurs origines (une suite est souvent AUSSI recommandée par
 * catégorie) et les poids ne sont pas comparables d'une origine à l'autre —
 * les écraser l'un l'autre perdrait le signal. L'ordre des colonnes met
 * `kind` en deuxième position pour que l'index serve aussi « tous les liens
 * `category` de cette source », la requête du moteur de recommandation.
 */
@Entity('manga_recommendation')
@Index(['source_mu_id', 'kind', 'recommended_mu_id'], { unique: true })
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

  /**
   * Origine du lien :
   * - `manual`   — `recommendations` (suggestions manuelles de la communauté,
   *   poids 1-220 observés) ; seule origine ingérée avant 2026-09-09 ;
   * - `category` — `category_recommendations` (dérivé des votes de catégorie,
   *   poids de l'ordre de 10 000 à 40 000) ;
   * - `related`  — `related_series` (suites, préquelles, spin-offs,
   *   adaptations) ; poids toujours 0, l'information est dans `relation_type`.
   *
   * Les poids ne sont JAMAIS comparables entre origines : la normalisation
   * est faite au scoring (`reco-graph-scoring.ts`), pas au stockage — on
   * conserve la valeur brute de MU pour pouvoir changer d'avis sans
   * re-télécharger le graphe.
   */
  @Column({
    type: 'varchar',
    length: RECO_LINK_KIND_MAX_LENGTH,
    default: 'manual',
  })
  kind: RecoLinkKind;

  /**
   * Type de parenté MU (`Sequel`, `Prequel`, `Side Story`, `Spin-Off`,
   * `Adapted From`…) — renseigné UNIQUEMENT pour `kind = 'related'`, NULL
   * partout ailleurs. C'est lui qui permet d'écarter les liens qui désignent
   * la même œuvre sous un autre support (`NON_DISCOVERY_RELATIONS`).
   */
  @Column({
    type: 'varchar',
    length: RELATION_TYPE_MAX_LENGTH,
    nullable: true,
  })
  relation_type: string | null;

  /**
   * Poids brut de MangaUpdates, dans l'échelle propre à `kind` (1-220 pour
   * `manual`, ~10 000-40 000 pour `category`, 0 pour `related`).
   */
  @Column({ type: 'int' })
  weight: number;

  @UpdateDateColumn()
  updated_at: Date;
}
