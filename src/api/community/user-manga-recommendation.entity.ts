import User from '@/api/user/user.entity';
import { Manga } from '@/api/mangas/manga.entity';
import {
  Check,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * Recommandation explicite d'un utilisateur Manga Tracker : « si vous avez
 * aimé `source`, je vous recommande `recommended` ».
 *
 * Demande produit (2026-09-30) : faire participer la communauté et alimenter
 * la base — l'équivalent maison des recommandations MangaUpdates (« 72
 * personnes recommandent Naruto pour One Piece »), dont le compteur s'ajoute
 * à celui de MU à l'affichage.
 *
 * Table DISTINCTE de `manga_recommendation` (graphe MU), volontairement :
 *  - elle porte un utilisateur (donnée personnelle : export RGPD, cascade à
 *    la suppression du compte) ;
 *  - une ligne = un vote, alors que `manga_recommendation` stocke un poids
 *    agrégé par MU ; y mêler des votes locaux fausserait tous les lecteurs
 *    qui comptent ses lignes (sections cachées, sleepers, hydratation).
 *
 * Unicité (user, source, recommended) : un seul vote par paire et par
 * utilisateur — recommander deux fois ne gonfle pas le compteur.
 */
@Entity('user_manga_recommendation')
@Check('CHK_user_reco_not_self', '"source_mu_id" <> "recommended_mu_id"')
@Unique('UQ_user_reco_user_source_target', ['user', 'source', 'recommended'])
@Index('IDX_user_reco_source_target', ['source', 'recommended'])
export class UserMangaRecommendation {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Manga, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'source_mu_id', referencedColumnName: 'mu_id' })
  source: Manga;

  @ManyToOne(() => Manga, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'recommended_mu_id', referencedColumnName: 'mu_id' })
  recommended: Manga;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}
