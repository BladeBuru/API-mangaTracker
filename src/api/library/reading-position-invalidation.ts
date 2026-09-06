/** Nom du paramètre lié à la NOUVELLE valeur de `user_read_chapters`. */
export const NEW_READ_CHAPTERS_PARAM = 'newReadChapters';

/** Vrai quand le chapitre en cours de lecture vient d'être terminé. */
const OBSOLETE = `"current_chapter" IS NOT NULL AND :${NEW_READ_CHAPTERS_PARAM} >= "current_chapter"`;

/** `CASE` qui remet une colonne de position à NULL si elle est caduque. */
const clearIfObsolete = (column: string) =>
  `CASE WHEN ${OBSOLETE} THEN NULL ELSE "${column}" END`;

/**
 * Fragment `SET` (fusionnable dans `QueryBuilder.set()`) qui invalide la position de lecture en cours devenue
 * caduque, à fusionner dans l'UPDATE du pointeur de progression.
 *
 * Quand le nouveau `user_read_chapters` atteint ou dépasse `current_chapter`,
 * le chapitre où l'on lisait est terminé : proposer de « reprendre au milieu »
 * d'un chapitre déjà validé n'aurait aucun sens. Les trois colonnes repassent
 * donc à NULL **dans le même UPDATE** que le pointeur (donc dans la même
 * transaction que le backfill du journal) : ni requête supplémentaire, ni
 * lecture préalable, ni N+1 — PostgreSQL évalue la condition sur l'ancienne
 * valeur de la ligne.
 *
 * La condition porte sur la valeur FINALE du pointeur, pas sur le sens de la
 * variation : une correction à la baisse qui laisse malgré tout le chapitre en
 * cours derrière elle rend la position tout aussi caduque.
 *
 * L'appelant DOIT lier le paramètre `NEW_READ_CHAPTERS_PARAM`.
 */
export const readingPositionInvalidationSet = () => ({
  currentChapter: () => clearIfObsolete('current_chapter'),
  currentPositionPercent: () => clearIfObsolete('current_position_percent'),
  currentPositionUpdatedAt: () =>
    clearIfObsolete('current_position_updated_at'),
});
