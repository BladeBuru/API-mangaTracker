/**
 * Extraction du **graphe de voisinage œuvre-à-œuvre** de MangaUpdates depuis
 * la réponse `GET /v1/series/{id}` — fonctions PURES, aucune I/O.
 *
 * ## Les trois champs et ce qu'ils valent (mesuré le 2026-09-09)
 *
 * La même réponse contient TROIS listes de voisins, de qualité très inégale.
 * Relevé sur Solo Leveling (`15180124327`, Manhwa) :
 *
 * | champ                      | poids MU        | voisins obtenus                          |
 * |----------------------------|-----------------|------------------------------------------|
 * | `recommendations`          | 2 à 3           | Kimetsu no Yaiba, Vinland Saga…          |
 * | `category_recommendations` | 27 000 à 38 000 | Solo Leveling: Ragnarok, I Am the Final Boss… |
 * | `related_series`           | (aucun)         | Ragnarok (Sequel), le roman (Adapted From)… |
 *
 * `recommendations` (suggestions manuelles de la communauté) était le SEUL
 * champ ingéré : des mangas japonais sans rapport pour un lecteur de manhwa.
 * `category_recommendations`, dérivé des votes de catégorie, donne exactement
 * le bon voisinage — c'est le champ qui répare le produit.
 *
 * ## Deux formats à supporter
 *
 * `recommendations` / `category_recommendations` : format **plat** depuis
 * 2026-05 (`series_id: number`, `series_image.url.{original,thumb}`) ; le
 * format **imbriqué** historique (`series_id: { series_id, title, image }`)
 * reste géré par sécurité — cf. le commentaire « Format MU 2026-05 » de
 * `MangaDetailsDto.fromMU`, dont ce mapper est la généralisation.
 *
 * `related_series` a une forme à lui : `related_series_id`,
 * `related_series_name`, `relation_type` (Sequel, Prequel, Spin-Off,
 * Adapted From…). Pas de poids, pas de cover.
 */

/** Discriminant d'origine d'un lien du graphe (`manga_recommendation.kind`). */
export const RECO_LINK_KINDS = ['manual', 'category', 'related'] as const;

export type RecoLinkKind = (typeof RECO_LINK_KINDS)[number];

/** Longueur de la colonne `manga_recommendation.kind`. */
export const RECO_LINK_KIND_MAX_LENGTH = 16;

/** Longueur de la colonne `manga_recommendation.relation_type`. */
export const RELATION_TYPE_MAX_LENGTH = 48;

/**
 * Relations qui ne sont PAS une découverte : elles désignent la MÊME œuvre
 * sous un autre support ou une autre version (le roman dont le manhwa est
 * tiré, un remake). Proposer « Solo Leveling (Novel) » à quelqu'un qui lit
 * Solo Leveling n'est pas une recommandation, c'est un doublon.
 *
 * Les autres relations (Sequel, Prequel, Side Story, Spin-Off, Main Story,
 * Same Franchise…) restent des œuvres distinctes à lire : elles sont
 * conservées, mais scorées à part (cf. `reco-graph-scoring.ts`).
 */
export const NON_DISCOVERY_RELATIONS: ReadonlySet<string> = new Set([
  'adapted from',
  'adaptation',
  'alternate version',
  'alternative version',
]);

/** Lien pondéré (`recommendations` / `category_recommendations`). */
export interface MuNeighbourLink {
  seriesId: number;
  title: string;
  weight: number;
  smallCoverUrl: string | null;
  mediumCoverUrl: string | null;
}

/** Lien de parenté (`related_series`) — sans poids ni cover côté MU. */
export interface MuRelatedLink {
  seriesId: number;
  title: string;
  relationType: string | null;
}

/** Voisinage complet d'une série, tel que renvoyé par `/v1/series/{id}`. */
export interface SeriesNeighbourhood {
  manual: MuNeighbourLink[];
  category: MuNeighbourLink[];
  related: MuRelatedLink[];
  /** `type` de la série SOURCE (`Manga`, `Manhwa`…), `null` si absent. */
  sourceType: string | null;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Identifiant MU exploitable : entier fini strictement positif. */
function toSeriesId(value: unknown): number | null {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? Math.trunc(id) : null;
}

function toText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/** URLs de cover, format plat (`series_image`) ou imbriqué (`series_id.image`). */
function readCovers(raw: UnknownRecord, nested: UnknownRecord | null) {
  const image =
    asRecord(raw['series_image']) ??
    (nested ? asRecord(nested['image']) : null);
  const url = image ? asRecord(image['url']) : null;
  return {
    smallCoverUrl: toText(url?.['thumb'], 512),
    mediumCoverUrl: toText(url?.['original'], 512),
  };
}

/**
 * Une entrée de `recommendations` / `category_recommendations`.
 * `null` si l'entrée est inexploitable (pas d'id, poids nul ou négatif).
 */
function readNeighbour(raw: unknown): MuNeighbourLink | null {
  const record = asRecord(raw);
  if (!record) return null;

  const nested = asRecord(record['series_id']);
  const seriesId = toSeriesId(
    nested ? nested['series_id'] : record['series_id'],
  );
  if (seriesId === null) return null;

  const weight = Number(record['weight']);
  if (!Number.isFinite(weight) || weight <= 0) return null;

  const title = nested
    ? toText(nested['title'], 255) ?? toText(nested['series_name'], 255)
    : toText(record['series_name'], 255);

  return {
    seriesId,
    title: title ?? '',
    weight: Math.trunc(weight),
    ...readCovers(record, nested),
  };
}

/** Une entrée de `related_series`. */
function readRelated(raw: unknown): MuRelatedLink | null {
  const record = asRecord(raw);
  if (!record) return null;
  const seriesId = toSeriesId(record['related_series_id']);
  if (seriesId === null) return null;
  return {
    seriesId,
    title: toText(record['related_series_name'], 255) ?? '',
    relationType: toText(record['relation_type'], RELATION_TYPE_MAX_LENGTH),
  };
}

/**
 * Dédoublonne par `seriesId` en gardant le poids le plus fort et exclut
 * l'auto-référence. Indispensable avant l'upsert : PostgreSQL refuse un
 * `ON CONFLICT DO UPDATE` qui toucherait deux fois la même ligne dans un
 * seul INSERT.
 */
function dedupeNeighbours(
  links: MuNeighbourLink[],
  sourceMuId: number,
): MuNeighbourLink[] {
  const byId = new Map<number, MuNeighbourLink>();
  for (const link of links) {
    if (link.seriesId === sourceMuId) continue;
    const existing = byId.get(link.seriesId);
    if (!existing || link.weight > existing.weight)
      byId.set(link.seriesId, link);
  }
  return [...byId.values()];
}

function dedupeRelated(
  links: MuRelatedLink[],
  sourceMuId: number,
): MuRelatedLink[] {
  const byId = new Map<number, MuRelatedLink>();
  for (const link of links) {
    if (link.seriesId === sourceMuId) continue;
    if (!byId.has(link.seriesId)) byId.set(link.seriesId, link);
  }
  return [...byId.values()];
}

/**
 * Extrait les trois listes de voisins d'une réponse `/v1/series/{id}`.
 *
 * Tolérant : un payload vide, partiel ou d'une forme inattendue renvoie des
 * listes vides plutôt que de lever — ce mapper est appelé sur le chemin
 * chaud (`getMangaDetails`) comme dans le job de rattrapage, et une fiche
 * MU exotique ne doit jamais faire échouer l'appelant.
 *
 * @param sourceMuId `mu_id` de la série dont on lit la fiche (exclusion des
 *   auto-références : MU liste parfois la série elle-même).
 */
export function mapSeriesNeighbourhood(
  sourceMuId: number,
  payload: unknown,
): SeriesNeighbourhood {
  const record = asRecord(payload);
  if (!record) {
    return { manual: [], category: [], related: [], sourceType: null };
  }

  const manual = asArray(record['recommendations'])
    .map(readNeighbour)
    .filter((link): link is MuNeighbourLink => link !== null);
  const category = asArray(record['category_recommendations'])
    .map(readNeighbour)
    .filter((link): link is MuNeighbourLink => link !== null);
  const related = asArray(record['related_series'])
    .map(readRelated)
    .filter((link): link is MuRelatedLink => link !== null);

  return {
    manual: dedupeNeighbours(manual, sourceMuId),
    category: dedupeNeighbours(category, sourceMuId),
    related: dedupeRelated(related, sourceMuId),
    sourceType: toText(record['type'], 32),
  };
}

/** `true` si la relation désigne une œuvre DISTINCTE (donc recommandable). */
export function isDiscoverableRelation(relationType: string | null): boolean {
  if (!relationType) return true;
  return !NON_DISCOVERY_RELATIONS.has(relationType.trim().toLowerCase());
}
