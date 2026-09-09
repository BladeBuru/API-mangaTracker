import { UserManga } from '@/api/mangas/user-manga.entity';

/**
 * Affinité d'un titre de bibliothèque — fonction PURE, source unique du
 * multiplicateur `statut × note perso × récence`.
 *
 * Le même calcul existait à l'identique dans trois fichiers, chacun
 * documenté comme « miroir de `RecommendationService.computeMultiplier` » :
 * `RecommendationService`, `CatalogCandidateService` et
 * `reco-graph-scoring`. Trois copies d'une formule qui pondère TOUS les
 * scores, c'est trois occasions de dériver — et une dérive entre deux
 * chemins de reco se lit à l'écran comme un ordre instable.
 *
 * ⚠️ `type-profile.libraryWeight` n'est PAS un miroir : il omet
 * volontairement la récence (le goût pour un format est un trait stable).
 */

/**
 * Multiplicateur appliqué selon le statut de lecture.
 * Un manga `completed` ou `caughtUp` est un signal fort de goût.
 * Un manga juste planifié pèse moins.
 */
export const STATUS_MULTIPLIER: Record<string, number> = {
  completed: 1.5,
  caughtUp: 1.3,
  reading: 1.2,
  readLater: 0.8,
};

/**
 * Demi-vie de pertinence en jours. Un manga ajouté il y a 1 an a un poids
 * ~0.37. Les goûts évoluent — on favorise les mangas récemment ajoutés.
 */
export const RECENCY_HALF_LIFE_DAYS = 365;

/**
 * `m_total = m_rating × m_status × m_recency`.
 *
 * @param now horloge injectable (tests) — `Date.now()` par défaut.
 */
export function computeAffinityMultiplier(
  um: UserManga,
  now: number = Date.now(),
): number {
  const rating = Number(um.user_rating) || 0;
  const ratingMultiplier = rating > 0 ? rating / 5.0 : 1.0;
  const statusMultiplier = STATUS_MULTIPLIER[um.readingStatus] ?? 1.0;
  const ageDays = um.adding_date
    ? (now - um.adding_date.getTime()) / 86_400_000
    : 0;
  return (
    ratingMultiplier * statusMultiplier * Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS)
  );
}
