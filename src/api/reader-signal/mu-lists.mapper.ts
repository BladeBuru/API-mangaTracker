import {
  isReaderListType,
  MU_RATING_MAX,
  MU_RATING_MIN,
  ReaderListType,
} from './reader-signal-weights';

/**
 * Mapping des réponses « listes » de MangaUpdates vers nos structures
 * internes. Fichier PUR (aucun I/O) : c'est le **point de filtrage RGPD**
 * unique du module — tout ce qui n'est pas retenu ici n'existe nulle part
 * en aval.
 *
 * Forme des réponses relevée par appels réels le 2026-09-09 (voir
 * `.claude/memory-bank/decisions.md`).
 */

// ───────────────────────── Payloads MangaUpdates ─────────────────────────

/**
 * Entrée de `GET /v1/lists/similar/{type}/{series_id}`.
 *
 * Clés réellement renvoyées : `user_id`, `user_name`, `user_rating`,
 * `intersect_count`, `percent_match`. `user_name` est déclaré ici **pour
 * documenter qu'il existe et qu'on le jette** — aucun code ne le lit.
 * `intersect_count` / `percent_match` sont systématiquement `null` en
 * anonyme (mesuré sur 500+ entrées).
 */
export interface MuSimilarUser {
  user_id?: number | string;
  user_name?: string;
  user_rating?: number | string | null;
  intersect_count?: number | null;
  percent_match?: number | null;
}

/** Corps de `GET /v1/lists/similar/{type}/{series_id}`. */
export interface MuSimilarBody {
  /**
   * ATTENTION : ce n'est PAS le nombre total de lecteurs de la série, mais
   * le nombre d'entrées RENVOYÉES — MU plafonne la réponse à 100 et renvoie
   * alors `total_hits: 100` (vérifié sur des séries à plusieurs milliers de
   * lecteurs). Aucune pagination n'est offerte : ce plafond est définitif.
   */
  total_hits?: number;
  users?: MuSimilarUser[];
}

/** Entrée de `GET /v1/lists/public/{user_id}`. */
export interface MuPublicList {
  list_id?: number | string;
  title?: string;
  description?: string;
  type?: string;
  icon?: string | null;
  /** `true` pour une liste personnalisée — son `list_id` est arbitraire. */
  custom?: boolean;
}

/** Entrée de `POST /v1/lists/public/{user_id}/search/{list_id}`. */
export interface MuListEntry {
  series_id?: number | string;
  series_title?: string;
  series_url?: string;
  metadata?: {
    /**
     * Présent UNIQUEMENT si le propriétaire de la liste a activé
     * `options.show_rating`. Absent ≠ « pas noté » : la note peut exister et
     * être masquée. Les deux cas sont indiscernables et traités pareil.
     */
    user_rating?: number | string | null;
    user_comment?: unknown;
  } | null;
}

/** Corps de `POST /v1/lists/public/{user_id}/search/{list_id}`. */
export interface MuListSearchBody {
  total_hits?: number;
  page?: number;
  per_page?: number;
  list?: { list_id?: number | string; type?: string } | null;
  results?: MuListEntry[];
}

// ───────────────────────────── Sorties internes ──────────────────────────

/**
 * Lecteur découvert. `userId` est l'identifiant MU BRUT : il ne vit que dans
 * la mémoire du run, le temps d'appeler MU. Il n'est jamais persisté (cf.
 * `ReaderProfile`).
 */
export interface DiscoveredReader {
  userId: string;
  /** Note du lecteur SUR LA SÉRIE SONDÉE, ou `null`. */
  rating: number | null;
}

/** Ligne de signal prête à écrire, déjà dépouillée de tout identifiant. */
export interface RawSignalRow {
  muId: string;
  listType: ReaderListType;
  rating: number | null;
}

/** Liste publique retenue pour l'extraction. */
export interface PublicListRef {
  listId: string;
  listType: ReaderListType;
}

/** Un identifiant MU est un entier positif — tout le reste est rejeté. */
function normalizeId(raw: unknown): string | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  if (text === '0') return null;
  return String(BigInt(text));
}

/**
 * Normalise une note MU vers `[1, 10]`, arrondie au centième (précision de
 * la colonne). Hors bornes, non numérique, `null` → `null` : « inconnue »,
 * jamais une valeur inventée.
 */
export function normalizeRating(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) return null;
  if (value < MU_RATING_MIN || value > MU_RATING_MAX) return null;
  return Math.round(value * 100) / 100;
}

/**
 * Extrait les lecteurs d'une réponse `/lists/similar/{type}/{mu_id}`.
 *
 * **Ne retient que `user_id` et `user_rating`.** `user_name` est présent
 * dans le payload et n'est ni lu, ni copié, ni loggé — c'est ici que la
 * promesse « aucun champ identifiant persisté » est tenue, en amont de tout
 * le reste. Les entrées sans identifiant exploitable sont écartées, et les
 * doublons de `user_id` (jamais observés, mais rien ne les interdit)
 * dédoublonnés en gardant la première note non nulle.
 */
export function extractDiscoveredReaders(
  body: MuSimilarBody | null | undefined,
): DiscoveredReader[] {
  const users = body?.users ?? [];
  const byId = new Map<string, DiscoveredReader>();
  for (const entry of users) {
    const userId = normalizeId(entry?.user_id);
    if (userId === null) continue;
    const rating = normalizeRating(entry?.user_rating);
    const existing = byId.get(userId);
    if (existing === undefined) {
      byId.set(userId, { userId, rating });
    } else if (existing.rating === null && rating !== null) {
      existing.rating = rating;
    }
  }
  return [...byId.values()];
}

/**
 * Listes publiques exploitables d'un lecteur.
 *
 * Un lecteur peut exposer PLUSIEURS listes du même type — les listes
 * personnalisées portent le `type` de la liste native dont elles dérivent
 * (mesuré : un compte avec `read`/`complete`/`read`). Elles sont toutes
 * retenues : l'unicité `(user_hash, mu_id, list_type)` fusionne
 * naturellement leurs contenus côté base.
 *
 * Une liste dont le `type` n'est pas l'un des cinq connus est ignorée
 * plutôt que devinée : mieux vaut perdre une liste exotique que de lui
 * attribuer une pondération arbitraire.
 */
export function extractPublicLists(
  body: MuPublicList[] | null | undefined,
): PublicListRef[] {
  if (!Array.isArray(body)) return [];
  const out: PublicListRef[] = [];
  const seen = new Set<string>();
  for (const list of body) {
    const listId = list?.list_id;
    // `list_id: 0` (Reading List) est légitime : on ne peut pas s'appuyer
    // sur `normalizeId`, qui rejette 0 comme identifiant de série invalide.
    if (typeof listId !== 'number' && typeof listId !== 'string') continue;
    const idText = String(listId).trim();
    if (!/^\d+$/.test(idText)) continue;
    if (!isReaderListType(list?.type)) continue;
    if (seen.has(idText)) continue;
    seen.add(idText);
    out.push({ listId: idText, listType: list.type });
  }
  return out;
}

/**
 * Lignes de signal d'une page de liste publique.
 *
 * `series_title` et `series_url` sont présents dans le payload et
 * délibérément ignorés : la table `manga` porte déjà le titre, et l'URL est
 * une donnée de plus à ne pas dupliquer. Seuls `series_id` (= `mu_id`) et la
 * note éventuelle sont retenus.
 */
export function extractListEntries(
  body: MuListSearchBody | null | undefined,
  listType: ReaderListType,
): RawSignalRow[] {
  const results = body?.results ?? [];
  const byMuId = new Map<string, RawSignalRow>();
  for (const entry of results) {
    const muId = normalizeId(entry?.series_id);
    if (muId === null) continue;
    const rating = normalizeRating(entry?.metadata?.user_rating);
    const existing = byMuId.get(muId);
    if (existing === undefined) {
      byMuId.set(muId, { muId, listType, rating });
    } else if (existing.rating === null && rating !== null) {
      existing.rating = rating;
    }
  }
  return [...byMuId.values()];
}

/**
 * Nombre de pages à demander pour une liste, d'après `total_hits`.
 *
 * `perpage` accepte jusqu'à **1000** sur cet endpoint (vérifié : 1000 →
 * écho `per_page: 1000` et 926 résultats ; 2000 et 5000 → coercition
 * silencieuse à 25, l'écho `per_page` faisant foi). Une liste dépasse donc
 * rarement une seule requête — d'où le plafond `maxPages`, garde-fou contre
 * un compte à 50 000 titres qui mangerait le budget de la nuit.
 */
export function pagesNeeded(
  totalHits: number | undefined,
  perPage: number,
  maxPages: number,
): number {
  const hits = Number(totalHits);
  if (!Number.isFinite(hits) || hits <= 0) return 0;
  return Math.min(maxPages, Math.ceil(hits / perPage));
}
