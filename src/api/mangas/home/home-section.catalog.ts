import { MU_SHARDABLE_GENRES } from '../constants';
import { isKnownMangaType, normalizeMangaType } from '../manga-type';

/**
 * Catalogue des sections de l'accueil « façon Netflix »
 * (`GET /mangas/home/sections`) — définitions PURES : ordre, identifiants,
 * paramètres, validation d'un `id`. Aucune I/O ; les requêtes vivent dans
 * `HomeSectionQueryBuilder`, l'assemblage dans `HomeSectionsService`.
 *
 * Le contrat est partagé avec le client Flutter (qui traduit le titre à
 * partir de `kind` + `params`) : ne pas changer les `kind` ni la forme des
 * `params` sans bump de version.
 */
export type HomeSectionKind =
  | 'latest'
  | 'popular'
  | 'top_rated'
  | 'type'
  | 'genre'
  | 'year'
  | 'community'
  | 'hidden_gems';

export interface HomeSectionDef {
  /** Identifiant stable (`latest`, `type:Manhwa`, `genre:Action`, `year:2014`). */
  id: string;
  kind: HomeSectionKind;
  params: Record<string, string | number>;
}

/**
 * Sections par type : les trois formats que distinguent les recommandations.
 * Tant que la colonne `manga.type` n'est pas rattrapée, une section peut
 * compter moins de 5 titres et être omise — c'est prévu.
 */
export const HOME_TYPES: readonly string[] = ['Manhwa', 'Manhua', 'Manga'];

/**
 * Genres exposés sur l'accueil : 6 parmi les plus fournis du catalogue
 * (mesuré le 2026-09-05 sur 80 000 titres : Romance 39 k, Drama 34 k,
 * Fantasy 25 k, Comedy 24 k, Action 14.6 k, Adventure 8 k). `Slice of Life`
 * (17 k) et `Shoujo`/`Shounen` (démographies, pas genres) sont laissés aux
 * pages de détail via `genre:<G>`.
 */
export const HOME_GENRES: readonly string[] = [
  'Action',
  'Fantasy',
  'Romance',
  'Comedy',
  'Drama',
  'Adventure',
];

/**
 * Genres acceptés en détail (`genre:<G>`) : ceux du sous-découpage catalogue
 * (donc hors NSFW), moins les genres que la home segmentée des
 * recommandations exclut déjà de ses sections (`GenreSectionService`).
 */
const SECTION_EXCLUDED_GENRES = new Set(['Mature', 'Yaoi', 'Yuri', 'Ecchi']);
export const HOME_ALLOWED_GENRES: readonly string[] =
  MU_SHARDABLE_GENRES.filter((g) => !SECTION_EXCLUDED_GENRES.has(g));

/** Année la plus ancienne acceptée en détail (plancher du catalogue). */
export const HOME_YEAR_FLOOR = 1930;

/** Sections omises de l'accueil sous ce nombre de titres. */
export const MIN_SECTION_ITEMS = 5;

/** Numéro de semaine ISO-8601 (1..53). */
export function isoWeek(date: Date): number {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/**
 * Année « rétro » tournante : entre 10 et 15 ans en arrière, change chaque
 * semaine ISO (stable sur la semaine, donc stable pour le cache et pour
 * l'utilisateur qui revient le lendemain). Ex. 2026, semaine 36 → 2016.
 */
export function retroYear(now: Date): number {
  return now.getFullYear() - 10 - (isoWeek(now) % 6);
}

/**
 * Sections de l'accueil, dans l'ordre d'affichage décidé côté serveur :
 * nouveautés, populaires, communauté, meilleures notes, puis par type,
 * par genre, par année, et enfin les pépites. L'ordre est aussi celui de
 * la déduplication inter-sections (un titre n'apparaît que dans la première
 * section qui le sélectionne) : les pépites, en dernier, ne montrent que ce
 * qu'aucune autre section n'a déjà montré — ce qui en fait de vraies
 * découvertes.
 */
export function buildHomeSectionDefs(now: Date): HomeSectionDef[] {
  const year = now.getFullYear();
  return [
    { id: 'latest', kind: 'latest', params: {} },
    { id: 'popular', kind: 'popular', params: {} },
    { id: 'community', kind: 'community', params: {} },
    { id: 'top_rated', kind: 'top_rated', params: {} },
    ...HOME_TYPES.map((type) => typeSection(type)),
    ...HOME_GENRES.map((genre) => genreSection(genre)),
    yearSection(year),
    yearSection(year - 1),
    yearSection(retroYear(now)),
    { id: 'hidden_gems', kind: 'hidden_gems', params: {} },
  ];
}

function typeSection(type: string): HomeSectionDef {
  return { id: `type:${type}`, kind: 'type', params: { type } };
}

function genreSection(genre: string): HomeSectionDef {
  return { id: `genre:${genre}`, kind: 'genre', params: { genre } };
}

function yearSection(year: number): HomeSectionDef {
  return { id: `year:${year}`, kind: 'year', params: { year } };
}

const FIXED_KINDS: ReadonlySet<string> = new Set<HomeSectionKind>([
  'latest',
  'popular',
  'top_rated',
  'community',
  'hidden_gems',
]);

/**
 * Valide et normalise un `id` de section (détail paginé). `null` = inconnu
 * → 404 côté controller. Accepte tout type MU connu (`type:Novel` est une
 * page valide même s'il n'est pas sur l'accueil), les genres non exclus et
 * toute année entre le plancher et l'année courante.
 */
export function parseHomeSectionId(
  id: string,
  now: Date,
): HomeSectionDef | null {
  if (FIXED_KINDS.has(id)) {
    return { id, kind: id as HomeSectionKind, params: {} };
  }
  const separator = id.indexOf(':');
  if (separator <= 0) return null;
  const kind = id.slice(0, separator);
  const value = id.slice(separator + 1);
  if (value.length === 0) return null;

  if (kind === 'type') {
    const type = normalizeMangaType(value);
    return type && isKnownMangaType(type) ? typeSection(type) : null;
  }
  if (kind === 'genre') {
    const genre = HOME_ALLOWED_GENRES.find(
      (g) => g.toLowerCase() === value.trim().toLowerCase(),
    );
    return genre ? genreSection(genre) : null;
  }
  if (kind === 'year') {
    if (!/^\d{4}$/.test(value)) return null;
    const year = Number(value);
    if (year < HOME_YEAR_FLOOR || year > now.getFullYear()) return null;
    return yearSection(year);
  }
  return null;
}
