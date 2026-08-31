import { NSFW_GENRES } from './constants';

/**
 * Nature d'un shard de catalogue :
 * - `global`     : passe non filtrée (`catalog:rating`, `catalog:week_pos`).
 * - `year`       : une année de publication (niveau 1).
 * - `year_genre` : une année × un genre (niveau 2, sous-découpage d'une
 *                  année saturée).
 */
export type CatalogShardKind = 'global' | 'year' | 'year_genre';

/**
 * Unité de travail de la synchronisation catalogue : une requête MU
 * paginable, identifiée par un `jobName` stable qui sert de clé dans
 * `catalog_sync_state`. Le curseur de reprise est porté par la ligne d'état
 * correspondante, JAMAIS par le shard lui-même (qui est recalculé à chaque
 * run).
 */
export interface CatalogShard {
  /** Clé unique = `catalog_sync_state.job_name`. */
  jobName: string;
  kind: CatalogShardKind;
  /**
   * Profondeur de découpage : 0 = global, 1 = année, 2 = année × genre.
   * Le sous-découpage s'arrête à 2 (cf. `CatalogShardPlannerService`).
   */
  level: 0 | 1 | 2;
  /** Critère de tri MU (`rating`, `week_pos`). */
  orderby: string;
  year?: number;
  genre?: string;
  /**
   * Plafond de pages propre au shard, quand le tri n'a de sens que sur les
   * premières pages (`week_pos` : le top hebdo, pas tout le catalogue).
   * Absent → le seul plafond est `ceil(total_hits / perpage)` borné par le
   * hard cap MU.
   */
  pageCap?: number;
}

/** `job_name` d'un shard annuel. */
export function yearShardJobName(year: number): string {
  return `catalog:year:${year}`;
}

/** `job_name` d'un sous-shard année × genre. */
export function yearGenreShardJobName(year: number, genre: string): string {
  return `catalog:year:${year}:genre:${genre}`;
}

/** Corps POST `/series/search` pour une page d'un shard donné. */
export function buildSearchBody(
  shard: CatalogShard,
  page: number,
  perPage: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    orderby: shard.orderby,
    perpage: perPage,
    page,
    exclude_genre: NSFW_GENRES,
  };
  if (shard.year !== undefined) body.year = shard.year;
  // MU attend un tableau même pour un genre unique.
  if (shard.genre !== undefined) body.genre = [shard.genre];
  return body;
}
