/**
 * Types de notification exposés au client (contrat partagé avec l'app
 * Flutter — ne pas renommer une valeur sans bump de version).
 */
export enum NotificationType {
  /** Quelqu'un m'a envoyé une demande d'amitié. */
  FriendRequest = 'friend_request',
  /** Ma demande d'amitié a été acceptée. */
  FriendAccepted = 'friend_accepted',
  /** Un ami m'a partagé un manga. */
  MangaShare = 'manga_share',
  /** Un ami m'a ajouté à un groupe de lecture. */
  ReadingGroupInvite = 'reading_group_invite',
  /** De nouveaux chapitres sont parus sur un manga que je lis. */
  NewChapters = 'new_chapters',
}

/** Longueur de la colonne `notification.type`. */
export const NOTIFICATION_TYPE_MAX_LENGTH = 32;

/**
 * Contenu STOCKÉ dans `notification.data` (jsonb), par type.
 *
 * Uniquement des identifiants et des compteurs : les textes rédigés par un
 * autre utilisateur (message de partage, nom de groupe) sont relus en
 * direct à l'affichage. Ainsi, quand l'auteur supprime son compte (RGPD,
 * article 17) ou retire son partage, son texte ne survit pas dans la boîte
 * de réception d'autrui.
 */
export interface FriendshipNotificationData {
  friendshipId: number;
}

export interface MangaShareStoredData {
  shareId: number;
}

export interface ReadingGroupInviteStoredData {
  groupId: number;
}

export interface NewChaptersNotificationData {
  /** Total de chapitres connu au moment de la notification (le plus récent). */
  latestChapter: number;
  /** Total AVANT la première hausse non lue (conservé lors des cumuls). */
  previousTotal: number;
  /** Dernier chapitre terminé par l'utilisateur. */
  readChapters: number;
}
