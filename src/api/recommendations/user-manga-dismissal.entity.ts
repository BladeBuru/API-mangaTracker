import User from '@/api/user/user.entity';
import { Manga } from '@/api/mangas/manga.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { DismissalReason } from './dismissal-reason.enum';

/**
 * « Pas intéressé / déjà vu » : un titre que l'utilisateur a explicitement
 * écarté de ses recommandations.
 *
 * Besoin fondateur : « On me recommande One Piece et Naruto. Les deux, c'est
 * les meilleurs, les plus connus. Sauf que moi je les ai — j'adore, mais je
 * les ai vus en animé et je n'ai pas forcément envie de les relire. » Aucun
 * algorithme ne peut deviner ça : l'information n'existe dans aucune source
 * (ni MangaUpdates, ni la bibliothèque, ni les notes). Il faut la capter.
 *
 * Sémantique : un rejet est un **filtre définitif mais réversible**. Le titre
 * ne remonte plus dans AUCUN chemin de recommandation tant que la ligne
 * existe ; la supprimer le réintègre immédiatement (invalidation du
 * `RecoCacheService` des deux côtés).
 *
 * Ce n'est PAS un masquage de la bibliothèque : rejeter un titre ne
 * l'empêche ni d'être cherché, ni d'être ouvert, ni d'être ajouté en biblio
 * — seules les recommandations le filtrent.
 *
 * Unicité (user, manga) : un seul rejet actif par titre et par utilisateur.
 * Un second rejet écrase la raison du premier (upsert `ON CONFLICT DO
 * UPDATE`), d'où l'index UNIQUE requis.
 */
@Entity('user_manga_dismissal')
@Unique('UQ_dismissal_user_manga', ['user', 'manga'])
export class UserMangaDismissal {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Index simple sur `user_id` : chemin chaud absolu — la liste des rejets
   * est chargée à CHAQUE calcul de recommandations (liste plate, sections
   * par genre, sleepers, cold start, fiche détail).
   */
  @Index('IDX_dismissal_user')
  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Manga, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'manga_id', referencedColumnName: 'mu_id' })
  manga: Manga;

  /**
   * Raison typée (cf. `DismissalReason`). Volontairement obligatoire : c'est
   * la valeur de la donnée pour l'entraînement d'un futur modèle, pas un
   * détail d'UI.
   */
  @Column({ type: 'varchar', length: 32, nullable: false })
  reason: DismissalReason;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;
}
