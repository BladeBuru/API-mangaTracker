/**
 * Raison pour laquelle un utilisateur écarte un titre de ses recommandations.
 *
 * La raison est **typée et obligatoire** : c'est le seul signal négatif
 * explicite dont dispose le produit. La base de prod ne contient que 4 notes
 * utilisateur pour 6 comptes — un futur moteur de recommandation aura besoin
 * de distinguer « je connais déjà, ne me le propose plus » (signal d'affinité
 * POSITIF mal exploité) de « ça ne m'intéresse pas » (signal NÉGATIF réel).
 * Un simple booléen « masqué » perdrait cette distinction pour toujours.
 *
 * Stocké en `varchar(32)` et non en enum PostgreSQL : c'est la convention du
 * repo (cf. `UserManga.readingStatus` / `ReadingStatus`), et ajouter une
 * valeur à un enum PG impose une migration alors qu'ici il suffit d'étendre
 * l'enum applicatif validé par `class-validator`.
 */
export enum DismissalReason {
  /** Déjà lu (en papier, en scan…) — affinité positive, mais rien à découvrir. */
  AlreadyRead = 'already_read',

  /** Pas intéressé — vrai signal négatif de goût. */
  NotInterested = 'not_interested',

  /**
   * Vu ailleurs : animé, drama, film… Le cas d'usage fondateur
   * (« je les ai vus en animé et je n'ai pas envie de les relire ») :
   * l'information n'existe dans aucune source, seul l'utilisateur l'a.
   */
  SeenElsewhere = 'seen_elsewhere',
}

/** Valeurs acceptées par l'API, pour la validation et la doc Swagger. */
export const DISMISSAL_REASONS: DismissalReason[] =
  Object.values(DismissalReason);
