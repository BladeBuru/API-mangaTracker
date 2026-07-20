import { ConfigService } from '@nestjs/config';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { normalizeGenres } from './genre.utils';
import { Manga } from './manga.entity';

/** Item du payload search MU (`/series/search`). */
export interface MuSearchResult {
  record?: {
    series_id?: number | string;
    title?: string;
    year?: string | number;
    bayesian_rating?: number | null;
    image?: {
      url?: { original?: string | null; thumb?: string | null } | null;
    } | null;
    genres?: unknown;
  };
}

export interface MuSearchBody {
  results?: MuSearchResult[];
  total_hits?: number;
}

export interface CatalogPage {
  records: MuSearchResult[];
  totalHits: number;
}

export interface CatalogUpsertRows {
  /** Lignes dont le payload MU contient des genres exploitables. */
  withGenres: Array<QueryDeepPartialEntity<Manga>>;
  /** Lignes sans genres — upsertées SANS la colonne `genres`. */
  withoutGenres: Array<QueryDeepPartialEntity<Manga>>;
}

/**
 * Mappe les records d'une page search MU vers des lignes d'upsert `manga`,
 * séparées en deux lots (avec / sans genres) pour que le lot sans genres
 * n'écrase jamais des genres existants par null. Les records sans
 * `series_id` exploitable sont ignorés.
 */
export function buildCatalogUpsertRows(
  records: MuSearchResult[],
): CatalogUpsertRows {
  const withGenres: Array<QueryDeepPartialEntity<Manga>> = [];
  const withoutGenres: Array<QueryDeepPartialEntity<Manga>> = [];

  for (const item of records) {
    const record = item?.record;
    const seriesId = Number(record?.series_id);
    if (!record || !Number.isFinite(seriesId) || seriesId <= 0) continue;
    const genres = normalizeGenres(record.genres);
    const yearNum = Number.parseInt(String(record.year ?? ''), 10);
    const row: QueryDeepPartialEntity<Manga> = {
      mu_id: String(seriesId),
      title: record.title || `Manga ${seriesId}`,
      year: Number.isFinite(yearNum) ? yearNum : null,
      rating:
        typeof record.bayesian_rating === 'number'
          ? record.bayesian_rating
          : null,
      small_cover_url: record.image?.url?.thumb ?? null,
      medium_cover_url: record.image?.url?.original ?? null,
    };
    if (genres && genres.length > 0) withGenres.push({ ...row, genres });
    else withoutGenres.push(row);
  }

  return { withGenres, withoutGenres };
}

/** Lit un entier > 0 depuis la config, sinon retourne le défaut. */
export function intFromConfig(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const value = Number(config.get<string>(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
