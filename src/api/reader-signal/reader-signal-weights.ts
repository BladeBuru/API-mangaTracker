/**
 * Vocabulaire et pondération du signal de lecture public MangaUpdates.
 *
 * Fichier volontairement PUR (aucune dépendance NestJS, aucun I/O) : c'est
 * la seule définition de « ce que vaut » une ligne de signal, partagée par
 * l'ingestion (`ReaderSignalCollectService`) et par l'agrégation
 * (`ReaderSignalAggregateService`, qui la reprojette en SQL). Une divergence
 * entre les deux fausserait silencieusement toutes les co-occurrences.
 */

/**
 * Types de liste exposés par MangaUpdates
 * (`GET /v1/lists/similar/{type}/{series_id}`, champ `type` de
 * `GET /v1/lists/public/{user_id}`). Relevés sur l'API le 2026-09-09 :
 * ce sont les cinq seules valeurs acceptées, tout autre type répond 404.
 */
export const READER_LIST_TYPES = [
  'complete',
  'read',
  'wish',
  'unfinished',
  'hold',
] as const;

export type ReaderListType = (typeof READER_LIST_TYPES)[number];

/** Longueur de la colonne `reader_signal.list_type`. */
export const READER_LIST_TYPE_MAX_LENGTH = 16;

/**
 * `list_id` canoniques de MangaUpdates, relevés le 2026-09-09 sur
 * `GET /v1/lists/public/{user_id}` : 0 = Reading, 1 = Wish, 2 = Complete,
 * 3 = Unfinished, 4 = On Hold.
 *
 * On ne s'en sert PAS pour construire les requêtes — la réponse fournit le
 * couple (`list_id`, `type`) et c'est elle qui fait foi, y compris pour les
 * listes personnalisées (`custom: true`) dont l'id est arbitraire. La table
 * ne sert qu'à retomber sur nos pieds si un jour `type` manquait.
 */
export const MU_LIST_ID_TO_TYPE: Readonly<Record<number, ReaderListType>> = {
  0: 'read',
  1: 'wish',
  2: 'complete',
  3: 'unfinished',
  4: 'hold',
};

/**
 * Affinité de base par type de liste, dans `[-1, 1]`.
 *
 * ## Justification
 *
 * - `complete` (**+1.00**) — le lecteur est allé au bout. C'est le seul type
 *   qui prouve à la fois l'intérêt ET la persévérance ; c'est aussi le plus
 *   dense (mesuré : 100 lecteurs sur les têtes de catalogue).
 * - `read` (**+0.60**) — lecture en cours : engagement réel, mais aucun
 *   verdict. Un lecteur peut abandonner demain. Positif, moitié moins fort.
 * - `wish` (**+0.25**) — intention seule. Fortement biaisée par la hype
 *   (une wish-list ressemble à un classement de popularité, pas à un goût) :
 *   utile pour rapprocher deux titres « du même moment », faible sinon.
 * - `hold` (**-0.25**) — mise en pause : négatif mais ambigu, le lecteur
 *   peut reprendre. On ne veut pas punir un titre long au prétexte que ses
 *   lecteurs font des pauses.
 * - `unfinished` (**-0.50**) — abandon assumé. C'est le signal qui manque
 *   totalement au produit (0 rejet en base) et le seul qui permette de dire
 *   « ces deux titres ne s'adressent PAS au même lecteur ».
 *
 * Les négatifs sont volontairement plus petits en valeur absolue que les
 * positifs : ils sont ~5× moins nombreux (mesuré sur Solo Leveling :
 * complete 100 / read 100 / wish 56 / unfinished 32 / hold 18) et un
 * abandon reste plus bruité qu'une lecture terminée (temps disponible,
 * scanlation arrêtée, changement de plateforme…).
 */
export const LIST_TYPE_AFFINITY: Readonly<Record<ReaderListType, number>> = {
  complete: 1.0,
  read: 0.6,
  wish: 0.25,
  unfinished: -0.5,
  hold: -0.25,
};

/** Bornes de la note MangaUpdates (échelle publique 1 → 10, pas de 0,1). */
export const MU_RATING_MIN = 1;
export const MU_RATING_MAX = 10;

/**
 * Note « neutre » : au-dessus le lecteur a aimé, en dessous il n'a pas aimé.
 *
 * 5.5 et non 5 : la distribution des notes MU est fortement tassée vers le
 * haut (les lecteurs notent surtout ce qu'ils ont aimé — mesuré : 44 notes
 * sur 100 lecteurs de Solo Leveling, dont l'écrasante majorité ≥ 8). Placer
 * le neutre au milieu de l'échelle *déclarée* plutôt qu'au milieu de
 * l'échelle *observée* rendrait négatives des notes de 5-6 qui traduisent en
 * réalité une lecture tiède, pas un rejet. 5.5 est le milieu exact de
 * `[1, 10]` et garde `ratingAffinity` symétrique sur `[-1, 1]`.
 */
export const MU_RATING_NEUTRAL = 5.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Affinité déduite d'une note MU, dans `[-1, 1]` : 10 → +1, 5.5 → 0, 1 → -1.
 * Les notes hors échelle sont ramenées dans `[1, 10]` avant conversion.
 */
export function ratingAffinity(rating: number): number {
  const bounded = clamp(rating, MU_RATING_MIN, MU_RATING_MAX);
  return clamp(
    (bounded - MU_RATING_NEUTRAL) / (MU_RATING_MAX - MU_RATING_NEUTRAL),
    -1,
    1,
  );
}

/**
 * Affinité d'une ligne de signal `(list_type, rating)`, dans `[-1, 1]`.
 *
 * Règle unique : **`w = min(affinité de la note, affinité du type)`**, la
 * note étant ignorée quand elle est absente.
 *
 * Pourquoi un `min` et non un produit :
 * - un produit ferait basculer `unfinished` + note basse en POSITIF (deux
 *   négatifs) — exactement le contresens qu'on veut éviter ;
 * - le `min` garantit qu'une note basse peut rendre n'importe quelle ligne
 *   négative (un `complete` noté 2/10 est un rejet, pas une recommandation),
 *   mais qu'une note haute ne peut JAMAIS rendre positif un abandon ni
 *   hisser une simple intention (`wish` noté 10 reste plafonné à +0.25).
 *
 * La monotonie est préservée dans les deux dimensions : à type constant,
 * l'affinité croît avec la note ; à note constante, elle croît avec le
 * plafond du type.
 */
export function signalAffinity(
  listType: ReaderListType,
  rating: number | null | undefined,
): number {
  const base = LIST_TYPE_AFFINITY[listType];
  if (rating === null || rating === undefined || !Number.isFinite(rating)) {
    return base;
  }
  return Math.min(ratingAffinity(rating), base);
}

/**
 * Contribution d'un lecteur à la co-occurrence de deux œuvres, à partir de
 * ses deux affinités.
 *
 * - **les deux positives** → `wa × wb` : « ce lecteur a aimé les deux »,
 *   c'est la similarité classique ;
 * - **une positive, une négative** → produit négatif : « les lecteurs qui
 *   aiment A abandonnent B ». C'est le signal de RÉPULSION, celui qui manque
 *   totalement au produit (0 rejet en base) ;
 * - **les deux négatives** → **0**, et non le produit (qui serait positif).
 *   « Il a abandonné les deux » parle de la tolérance du lecteur, pas de la
 *   parenté des titres ; en faire une similarité pleine rapprocherait deux
 *   œuvres sans rapport au seul motif qu'elles sont longues ou lentes. Le
 *   volume d'abandons (~5× moindre que les lectures terminées) ne justifie
 *   pas ce risque.
 */
export function pairContribution(affinityA: number, affinityB: number): number {
  if (affinityA <= 0 && affinityB <= 0) return 0;
  return affinityA * affinityB;
}

/** Version SQL de `pairContribution` — même règle, même endroit. */
export function pairContributionSql(exprA: string, exprB: string): string {
  return (
    `CASE WHEN ${exprA} <= 0 AND ${exprB} <= 0 THEN 0 ` +
    `ELSE ${exprA} * ${exprB} END`
  );
}

/**
 * Similarité cosinus d'une paire : somme des contributions rapportée au
 * produit des normes. Bornée dans `[-1, 1]`, elle rend comparables une paire
 * de best-sellers (des centaines de lecteurs communs) et une paire de niche.
 * `0` si l'une des normes est nulle — aucune information, pas une erreur.
 */
export function cosineScore(
  weight: number,
  normA: number,
  normB: number,
): number {
  if (!(normA > 0) || !(normB > 0)) return 0;
  return weight / (normA * normB);
}

/** `true` si la valeur est l'un des cinq types de liste MU connus. */
export function isReaderListType(value: unknown): value is ReaderListType {
  return (
    typeof value === 'string' &&
    (READER_LIST_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Expression SQL calculant `signalAffinity` sur une ligne `reader_signal`.
 *
 * L'agrégation tourne intégralement en SQL (des dizaines de millions de
 * paires : les remonter en mémoire n'est pas envisageable), il faut donc que
 * la pondération existe aussi en SQL. Elle est GÉNÉRÉE ici à partir des
 * mêmes constantes que la version TypeScript, jamais recopiée à la main :
 * une divergence entre les deux serait invisible et fausserait tout.
 *
 * @param alias Alias de la table `reader_signal` dans la requête.
 */
export function affinitySqlExpression(alias: string): string {
  const cases = READER_LIST_TYPES.map(
    (type) =>
      `WHEN '${type}' THEN LEAST(` +
      `COALESCE((${alias}.rating - ${MU_RATING_NEUTRAL}) / ` +
      `${MU_RATING_MAX - MU_RATING_NEUTRAL}, ${LIST_TYPE_AFFINITY[type]}), ` +
      `${LIST_TYPE_AFFINITY[type]})`,
  ).join(' ');
  // Le CLAMP reproduit `clamp(..., -1, 1)` de `ratingAffinity` : une note
  // aberrante (0, 11) ne doit pas sortir de l'intervalle.
  return `GREATEST(-1, LEAST(1, CASE ${alias}.list_type ${cases} ELSE 0 END))`;
}
