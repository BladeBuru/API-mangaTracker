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

export interface CatalogUpsertBatch {
  /**
   * Colonnes du `ON CONFLICT DO UPDATE SET` — jamais une colonne à null, pour
   * ne pas écraser une valeur déjà hydratée en base par un null MU.
   */
  overwrite: string[];
  /** Lignes partageant exactement ce jeu de colonnes non-null. */
  rows: Array<QueryDeepPartialEntity<Manga>>;
}

/** Toujours écrasée : MU search fournit toujours un titre. */
const ALWAYS_OVERWRITE_COLUMNS = ['title'] as const;

/**
 * Colonnes nullable protégées : elles ne sont écrasées QUE si le record MU
 * fournit une valeur non-null. Un record search sans `bayesian_rating`
 * (fréquent en `week_pos`) ne doit pas remettre à null une note déjà hydratée
 * (le manga sortirait de `CatalogCandidateService` rating>=7 / `findSleeperHits`).
 * Idem pour l'année et les covers (et les genres, historiquement protégés).
 */
const PROTECTED_NULLABLE_COLUMNS = [
  'year',
  'rating',
  'small_cover_url',
  'medium_cover_url',
  'genres',
] as const;

/**
 * Mappe les records d'une page search MU vers des lots d'upsert `manga`,
 * regroupés par jeu de colonnes NON-NULL. Chaque lot ne liste dans son
 * `overwrite` que les colonnes réellement renseignées → une colonne absente
 * du payload n'écrase jamais la valeur existante par null (protection
 * généralisée à rating/year/covers, pas seulement aux genres). Les records
 * sans `series_id` exploitable sont ignorés.
 */
export function buildCatalogUpsertBatches(
  records: MuSearchResult[],
): CatalogUpsertBatch[] {
  const batches = new Map<string, CatalogUpsertBatch>();

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
    if (genres && genres.length > 0) row.genres = genres;

    // Overwrite = colonnes toujours écrasées + colonnes protégées non-null.
    const rowFields = row as Record<string, unknown>;
    const overwrite = [
      ...ALWAYS_OVERWRITE_COLUMNS,
      ...PROTECTED_NULLABLE_COLUMNS.filter((col) => rowFields[col] != null),
    ];

    const key = overwrite.join(',');
    const batch = batches.get(key);
    if (batch) batch.rows.push(row);
    else batches.set(key, { overwrite, rows: [row] });
  }

  return [...batches.values()];
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
