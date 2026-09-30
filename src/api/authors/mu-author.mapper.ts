import { NSFW_GENRES } from '@/api/mangas/constants';
import { normalizeGenres } from '@/api/mangas/genre.utils';

/**
 * Lecture défensive des réponses MangaUpdates « auteurs » :
 *  - `GET  /v1/authors/{id}`         → fiche de l'auteur ;
 *  - `POST /v1/authors/{id}/series`  → ses œuvres.
 *
 * Fonctions pures (testables sans réseau). Tous les champs sont optionnels
 * côté MU : un champ absent ou d'une forme inattendue devient `null` / `[]`,
 * jamais une exception — une fiche auteur partielle vaut mieux qu'une erreur.
 */

export interface MuAuthorInfo {
  name: string;
  actualName: string | null;
  associatedNames: string[];
  imageUrl: string | null;
  bio: string | null;
  birthday: string | null;
  birthplace: string | null;
  genres: string[];
  officialSite: string | null;
}

export interface MuAuthorWork {
  muId: number;
  title: string;
  year: number | null;
  genres: string[];
}

/** Longueur maximale de la biographie renvoyée à l'app (« mini bio »). */
export const AUTHOR_BIO_MAX_LENGTH = 1200;
/** Genres principaux gardés pour la fiche auteur. */
export const AUTHOR_TOP_GENRES = 6;

type Json = Record<string, unknown>;

const asObject = (v: unknown): Json | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;

const asText = (v: unknown): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
};

/**
 * Texte MU → texte brut : balises HTML et BBCode retirés, entités de base
 * décodées, espaces normalisés, coupé proprement à [max] caractères.
 */
export function toPlainText(
  raw: unknown,
  max = AUTHOR_BIO_MAX_LENGTH,
): string | null {
  const text = asText(raw);
  if (!text) return null;
  const plain = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\/?[a-z*]+(=[^\]]*)?\]/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!plain) return null;
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function mapBirthday(raw: unknown): string | null {
  const obj = asObject(raw);
  if (obj) {
    const asString = asText(obj['as_string']);
    if (asString) return asString;
    const parts = [obj['year'], obj['month'], obj['day']]
      .map(asText)
      .filter((p): p is string => p !== null);
    return parts.length > 0 ? parts.join('-') : null;
  }
  return asText(raw);
}

function mapOfficialSite(raw: unknown): string | null {
  const social = asObject(raw);
  if (!social) return null;
  const site = social['officialsite'];
  const first = Array.isArray(site) ? site[0] : site;
  const url = asText(asObject(first)?.['url'] ?? first);
  return url && /^https?:\/\//i.test(url) ? url : null;
}

function mapGenres(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = raw
    .map((g) => {
      const obj = asObject(g);
      return asText(obj ? obj['genre'] ?? obj['name'] : g);
    })
    .filter((g): g is string => g !== null)
    .filter((g) => !NSFW_GENRES.includes(g));
  return [...new Set(names)].slice(0, AUTHOR_TOP_GENRES);
}

/** Fiche auteur MU → forme interne. `null` si le payload est inexploitable. */
export function mapMuAuthor(body: unknown): MuAuthorInfo | null {
  const data = asObject(body);
  const name = asText(data?.['name']);
  if (!data || !name) return null;

  const associated = Array.isArray(data['associated'])
    ? (data['associated'] as unknown[])
        .map((a) => asText(asObject(a)?.['name'] ?? a))
        .filter((a): a is string => a !== null && a !== name)
    : [];
  const image = asObject(asObject(data['image'])?.['url']);

  return {
    name,
    actualName: asText(data['actualname']),
    associatedNames: [...new Set(associated)].slice(0, 8),
    imageUrl: asText(image?.['original']) ?? asText(image?.['thumb']),
    bio: toPlainText(data['comments'] ?? data['bio'] ?? data['description']),
    birthday: mapBirthday(data['birthday']),
    birthplace: asText(data['birthplace']),
    genres: mapGenres(data['genres']),
    officialSite: mapOfficialSite(data['social']),
  };
}

/**
 * Œuvres d'un auteur. Accepte `series_list` (forme documentée) et, par
 * prudence, `results` / `series`. Les œuvres adultes (`NSFW_GENRES`) sont
 * retirées, comme partout ailleurs dans le catalogue ; les doublons aussi.
 */
export function mapMuAuthorWorks(body: unknown): MuAuthorWork[] {
  const data = asObject(body);
  const list =
    data?.['series_list'] ?? data?.['results'] ?? data?.['series'] ?? body;
  if (!Array.isArray(list)) return [];

  const seen = new Set<number>();
  const works: MuAuthorWork[] = [];
  for (const raw of list) {
    const item = asObject(raw);
    const record = asObject(item?.['record']) ?? item;
    if (!record) continue;
    const muId = Number(record['series_id'] ?? record['id']);
    if (!Number.isSafeInteger(muId) || muId <= 0 || seen.has(muId)) continue;
    const title = asText(record['title'] ?? record['series_name']);
    if (!title) continue;
    const genres = normalizeGenres(record['genres']) ?? [];
    if (genres.some((g) => NSFW_GENRES.includes(g))) continue;
    const year = Number.parseInt(String(record['year'] ?? ''), 10);
    seen.add(muId);
    works.push({
      muId,
      title,
      year: Number.isFinite(year) && year > 0 ? year : null,
      genres,
    });
  }
  return works;
}
