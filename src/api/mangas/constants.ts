export const MAL_TRENDS_URL = 'https://api.myanimelist.net/v2/manga/ranking';

export const MAL_DETAIL_URL = 'https://api.myanimelist.net/v2/manga/';

export const MU_TRENDS_URL = 'https://api.mangaupdates.com/v1/series/search';

export const MU_DETAIL_URL = 'https://api.mangaupdates.com/v1/series/';

export const NSFW_GENRES = [
  'Adult',
  'Smut',
  'Hentai',
  'Lolicon',
  'Shotacon',
  'Doujinshi',
];

/**
 * Genres MU exploitables pour le sous-découpage d'un shard annuel saturé.
 *
 * Source : `GET https://api.mangaupdates.com/v1/genres` (36 genres au
 * 2026-08-28), moins les 6 genres de `NSFW_GENRES` — déjà exclus de toutes
 * les requêtes catalogue via `exclude_genre`, les inclure ici produirait des
 * sous-shards systématiquement vides.
 *
 * Liste figée en constante plutôt que récupérée à chaud : elle ne bouge
 * quasiment jamais, et un appel réseau supplémentaire au moment du
 * découpage ajouterait un mode de panne sur un chemin déjà dégradé.
 */
export const MU_SHARDABLE_GENRES = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Ecchi',
  'Fantasy',
  'Gender Bender',
  'Harem',
  'Historical',
  'Horror',
  'Josei',
  'Martial Arts',
  'Mature',
  'Mecha',
  'Mystery',
  'Psychological',
  'Romance',
  'School Life',
  'Sci-fi',
  'Seinen',
  'Shoujo',
  'Shoujo Ai',
  'Shounen',
  'Shounen Ai',
  'Slice of Life',
  'Sports',
  'Supernatural',
  'Tragedy',
  'Yaoi',
  'Yuri',
] as const;
