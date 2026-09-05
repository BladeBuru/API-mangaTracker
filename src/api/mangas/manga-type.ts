/**
 * Types de publication MangaUpdates (`record.type` de `/series/search`,
 * `type` de `/series/{id}`). Liste relevée sur l'API le 2026-09-05.
 *
 * Les trois premiers sont ceux qui comptent pour le produit : ils
 * distinguent un manga japonais d'un manhwa coréen ou d'un manhua chinois —
 * la distinction qui manquait aux recommandations (un lecteur de manhwa
 * recevait exclusivement des mangas). Les autres sont conservés tels quels :
 * ils restent utiles au filtrage et coûtent zéro migration (colonne
 * `varchar(32)`, pas d'enum PostgreSQL).
 */
export const MANGA_TYPES = [
  'Manga',
  'Manhwa',
  'Manhua',
  'Novel',
  'OEL',
  'Doujinshi',
  'Artbook',
  'Drama CD',
  'Filipino',
  'Indonesian',
  'Thai',
  'Vietnamese',
  'Malaysian',
  'Nordic',
  'French',
  'Spanish',
] as const;

export type MangaType = (typeof MANGA_TYPES)[number];

/** Longueur de la colonne `manga.type` (migration `1788220800000`). */
export const MANGA_TYPE_MAX_LENGTH = 32;

/**
 * Types ciblés par le rattrapage nocturne dédié
 * (`CatalogTypeBackfillService`). Manhwa et manhua sont minoritaires dans
 * le catalogue MU (2015 : 561 manhwa sur 9 071 titres) : les rechercher
 * avec le filtre `type` de `/series/search` ramène chaque année en quelques
 * pages, là où le reste du catalogue (très majoritairement `Manga`) est
 * couvert par la synchro nightly ordinaire — dont le payload contient
 * désormais `record.type` pour chaque ligne revisitée.
 */
export const TYPE_BACKFILL_DEFAULT_TYPES: readonly MangaType[] = [
  'Manhwa',
  'Manhua',
];

const CANONICAL_BY_LOWER = new Map<string, MangaType>(
  MANGA_TYPES.map((type) => [type.toLowerCase(), type]),
);

/**
 * Normalise un type MU brut vers sa forme canonique.
 *
 * - `null` / `undefined` / non-chaîne / chaîne vide → `null` (inconnu) ;
 * - valeur connue (comparaison insensible à la casse et aux espaces) → forme
 *   canonique (`manhwa` → `Manhwa`) ;
 * - valeur inconnue mais plausible (≤ 32 caractères) → conservée trimée,
 *   pour ne pas perdre un type que MU ajouterait après cette liste ;
 * - au-delà de 32 caractères → `null` (la colonne ne peut pas la stocker).
 *
 * `null` signifie toujours « inconnu », jamais « pas de type » : la doctrine
 * null-safe (`PROTECTED_NULLABLE_COLUMNS`) fait qu'un `null` n'écrase
 * jamais une valeur déjà en base.
 */
export function normalizeMangaType(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MANGA_TYPE_MAX_LENGTH) {
    return null;
  }
  return CANONICAL_BY_LOWER.get(trimmed.toLowerCase()) ?? trimmed;
}

/** `true` si la valeur est l'un des types MU connus (forme canonique). */
export function isKnownMangaType(value: string): value is MangaType {
  return (MANGA_TYPES as readonly string[]).includes(value);
}
