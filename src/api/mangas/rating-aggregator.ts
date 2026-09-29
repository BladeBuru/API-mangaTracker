/**
 * Calcul de la note globale d'une œuvre, qui fusionne :
 *  - la note MangaUpdates (`bayesian_rating`, sur 10) et son nombre de
 *    votants (`rating_votes`) ;
 *  - les notes des utilisateurs Manga Tracker (`user_manga.user_rating`,
 *    1-10, 0 = pas de note).
 *
 * Deux régimes :
 *
 * 1. **Nombre de votants MU connu** (cas nominal depuis 2026-09-30) — vraie
 *    moyenne fusionnée, chaque vote pèse autant :
 *      global = (V × MU + n × moyenne_locale) / (V + n)
 *    et le total affiché vaut `V + n`. Demande produit : « des notes globales
 *    avec les utilisateurs de MangaUpdates ET les nôtres, et le total ».
 *
 * 2. **Nombre de votants MU inconnu** (fiche jamais rafraîchie depuis l'ajout
 *    de la colonne, liste qui ne le transmet pas) — repli historique :
 *    la note MU vaut `C` votants fictifs (`RATING_CONFIDENCE_WEIGHT`), pour
 *    qu'un seul vote local ne renverse pas la note. Le total ne compte alors
 *    que les votes locaux (`muRatingVotes = null`).
 *
 * Dans les deux cas : aucun vote local → note MU ; pas de note MU → moyenne
 * locale. Calcul à la lecture, rien n'est stocké (RETRO-011).
 */
export const RATING_CONFIDENCE_WEIGHT = 50;

export interface CommunityRating {
  /** Moyenne des notes locales (null si aucun votant local). */
  communityRating: number | null;
  /** Nombre de votants locaux (rating > 0). */
  communityRatingCount: number;
  /** Note globale (fusion MU + locale). */
  aggregatedRating: number;
  /** Votants MangaUpdates, `null` si inconnu. */
  muRatingVotes: number | null;
  /** Total des votes derrière la note globale (MU connus + locaux). */
  totalRatingVotes: number;
}

/**
 * Calcule la note communautaire et la note globale d'une œuvre.
 *
 * @param muRating Note MangaUpdates (sur 10). null/0 → communauté seule.
 * @param localAvg Moyenne locale des notes (rating > 0). Null si aucun.
 * @param localCount Nombre de notes locales.
 * @param confidenceWeight Poids de la note MU quand son nombre de votants
 *   est inconnu (régime 2).
 * @param muVotes Nombre de votants MU. > 0 → régime 1 (fusion au prorata).
 */
export function aggregateRating(
  muRating: number | null,
  localAvg: number | null,
  localCount: number,
  confidenceWeight: number = RATING_CONFIDENCE_WEIGHT,
  muVotes: number | null = null,
): CommunityRating {
  const safeLocalCount = Math.max(0, localCount);
  const safeLocalAvg = localAvg ?? 0;
  const safeMuRating = muRating ?? 0;
  const knownMuVotes =
    typeof muVotes === 'number' && Number.isFinite(muVotes) && muVotes > 0
      ? Math.round(muVotes)
      : null;
  const hasMuRating = safeMuRating > 0;

  let aggregated: number;
  if (safeLocalCount === 0) {
    aggregated = safeMuRating;
  } else if (!hasMuRating) {
    // Pas de note MU → on retourne juste la moyenne locale (peu fiable si
    // localCount est petit, mais c'est tout ce qu'on a)
    aggregated = safeLocalAvg;
  } else {
    const muWeight = knownMuVotes ?? confidenceWeight;
    aggregated =
      (muWeight * safeMuRating + safeLocalCount * safeLocalAvg) /
      (muWeight + safeLocalCount);
  }

  const countedMuVotes = hasMuRating ? knownMuVotes : null;
  return {
    communityRating: safeLocalCount > 0 ? safeLocalAvg : null,
    communityRatingCount: safeLocalCount,
    aggregatedRating: Math.round(aggregated * 100) / 100,
    muRatingVotes: countedMuVotes,
    totalRatingVotes: (countedMuVotes ?? 0) + safeLocalCount,
  };
}
