/**
 * Calcul d'une note "de confiance" combinant :
 *  - la note globale MangaUpdates (Bayesian rating, basée sur ~beaucoup de votants)
 *  - la note communautaire locale (moyenne des `user_rating` des utilisateurs
 *    Manga Tracker, échelle 1-10)
 *
 * Formule (moyenne pondérée Bayesienne) :
 *   aggregated = (C × MU_rating + n × community_avg) / (C + n)
 *
 * Où :
 *  - `C` est le « poids de confiance » accordé à la note MU. Exprimé en
 *    nombre équivalent de votants. Plus C est grand, plus la note locale
 *    devra avoir de votes pour faire bouger l'agrégat.
 *  - `n` = nombre d'utilisateurs locaux ayant noté.
 *  - `MU_rating` est sur 10 (l'API MU retourne un Bayesian rating
 *    déjà sur 10).
 *  - `community_avg` est sur 10 aussi (user_rating va de 1 à 10).
 *
 * Comportements clés :
 *  - n = 0 (personne en local n'a noté) → aggregated = MU_rating.
 *  - n = C → aggregated = (MU + local) / 2 (équilibre 50/50).
 *  - n >> C → aggregated ≈ community_avg (la communauté locale domine).
 *
 * Constante par défaut C = 50 : il faut 50 votes locaux pour qu'ils pèsent
 * autant que la note MU. Choisi pour donner une influence raisonnable à
 * la communauté locale sans qu'un seul vote ne renverse la note.
 */
export const RATING_CONFIDENCE_WEIGHT = 50;

export interface CommunityRating {
  /** Moyenne des notes locales (null si aucun votant local). */
  communityRating: number | null;
  /** Nombre de votants locaux (rating > 0). */
  communityRatingCount: number;
  /** Note agrégée selon la formule Bayesienne. */
  aggregatedRating: number;
}

/**
 * Calcule la note communautaire et la note agrégée pour un manga donné.
 *
 * @param muRating Note globale MangaUpdates (sur 10). Si null/0 → on utilise
 *   uniquement la communauté locale.
 * @param localAvg Moyenne locale des notes (rating > 0). Null si aucun.
 * @param localCount Nombre de notes locales.
 */
export function aggregateRating(
  muRating: number | null,
  localAvg: number | null,
  localCount: number,
  confidenceWeight: number = RATING_CONFIDENCE_WEIGHT,
): CommunityRating {
  const safeLocalCount = Math.max(0, localCount);
  const safeLocalAvg = localAvg ?? 0;
  const safeMuRating = muRating ?? 0;

  let aggregated: number;
  if (safeLocalCount === 0) {
    aggregated = safeMuRating;
  } else if (safeMuRating === 0) {
    // Pas de note MU → on retourne juste la moyenne locale (peu fiable si
    // localCount est petit, mais c'est tout ce qu'on a)
    aggregated = safeLocalAvg;
  } else {
    aggregated =
      (confidenceWeight * safeMuRating + safeLocalCount * safeLocalAvg) /
      (confidenceWeight + safeLocalCount);
  }

  return {
    communityRating: safeLocalCount > 0 ? safeLocalAvg : null,
    communityRatingCount: safeLocalCount,
    aggregatedRating: Math.round(aggregated * 100) / 100,
  };
}
