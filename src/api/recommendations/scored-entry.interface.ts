/**
 * Entrée scorée pour un manga candidat aux recommandations.
 * `sources` : map muId source → contribution au score (utilisé pour expliquer
 * « parce que vous avez aimé X, Y »).
 *
 * Partagée entre `RecommendationService` (construction du pool) et
 * `GenreSectionService` (consommation pour la home segmentée) — fichier
 * dédié pour éviter tout cycle d'import entre les deux services.
 */
export interface ScoredEntry {
  score: number;
  sources: Map<string, number>;
}
