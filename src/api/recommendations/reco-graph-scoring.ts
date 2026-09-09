import { UserManga } from '@/api/mangas/user-manga.entity';
import {
  isDiscoverableRelation,
  RecoLinkKind,
} from '@/api/mangas/reco-graph.mapper';

/**
 * Normalisation et agrégation du **graphe de voisinage MangaUpdates** —
 * fonctions PURES (aucune I/O), testables sans base.
 *
 * ## Le problème d'échelle
 *
 * Les trois origines de `manga_recommendation` ont des poids sans commune
 * mesure (mesuré le 2026-09-09) :
 *
 * - `manual`   : 2 à 220 (moyenne 12) — nombre de votes communautaires ;
 * - `category` : 27 000 à 38 000 sur Solo Leveling — dérivé des votes de
 *   catégorie, donc proportionnel à la POPULARITÉ de la série source ;
 * - `related`  : aucun poids, l'information est le `relation_type`.
 *
 * Les mélanger bruts ferait que la moindre entrée `category` écraserait
 * l'intégralité du scoring existant, et qu'une source populaire (poids
 * absolus énormes) noierait une source de niche pourtant mieux notée par
 * l'utilisateur.
 *
 * ## La normalisation retenue : relative À LA SOURCE
 *
 * Pour chaque (source, `category`), le poids est ramené à `w / wmax` de ce
 * groupe — soit un rang relatif dans (0, 1] — puis multiplié par
 * `CATEGORY_TOP_CONTRIBUTION`. Le meilleur voisin d'une source vaut donc
 * toujours 30, qu'il vienne d'un best-seller ou d'un titre confidentiel :
 * c'est bien la préférence de l'UTILISATEUR (via `multiplier` : statut, note
 * perso, récence — le même que le chemin `manual`) qui départage les
 * sources, pas la popularité MU. 30 est calibré entre la moyenne des poids
 * `manual` (12) et leurs valeurs exceptionnelles (220) : le graphe de
 * catégorie devient la source principale de candidats sans faire disparaître
 * une recommandation manuelle massivement votée.
 *
 * ## Les `related` ne sont pas des découvertes
 *
 * Une suite ou un spin-off d'une œuvre lue n'est pas une découverte : c'est
 * la suite logique. On les garde — « Solo Leveling: Ragnarok » est une vraie
 * proposition pour qui a fini Solo Leveling — mais **sous conditions** :
 *  1. la relation doit désigner une œuvre distincte (`isDiscoverableRelation`
 *     écarte `Adapted From` & co : le roman dont le manhwa est tiré est le
 *     même récit) ;
 *  2. la source doit être TERMINÉE ou à jour (`completed` / `caughtUp`) :
 *     proposer la suite d'une série qu'on lit au chapitre 12 est un spoiler
 *     et un contresens ;
 *  3. contribution forfaitaire basse (`RELATED_CONTRIBUTION` = 10, sous la
 *     moyenne des liens `manual`) : c'est un complément, jamais le cœur de
 *     la liste.
 */

/** Ligne brute du graphe telle que lue en base. */
export interface GraphLinkRow {
  source_mu_id: string;
  recommended_mu_id: string;
  kind: RecoLinkKind;
  relation_type: string | null;
  weight: number;
}

/** Ce que la bibliothèque dit d'une œuvre source. */
export interface GraphSourceContext {
  muId: string;
  /** Statut × note perso × récence — miroir de `computeMultiplier`. */
  multiplier: number;
  /** Lecture terminée ou à jour : les suites deviennent proposables. */
  finished: boolean;
}

/** Contribution d'un lien au score d'un candidat. */
export interface GraphContribution {
  muId: string;
  sourceMuId: string;
  kind: RecoLinkKind;
  score: number;
}

/** Contribution du MEILLEUR voisin `category` d'une source. */
export const CATEGORY_TOP_CONTRIBUTION = 30;

/** Contribution forfaitaire d'un lien `related` recevable. */
export const RELATED_CONTRIBUTION = 10;

/**
 * Voisins `category` retenus par source. MU en renvoie 5 aujourd'hui ; la
 * borne protège d'un élargissement futur de leur API qui déséquilibrerait le
 * pool en faveur des titres de la bibliothèque les plus connectés.
 */
export const MAX_CATEGORY_LINKS_PER_SOURCE = 12;

/** Statuts qui valent « j'ai aimé » (miroir de `STATUS_MULTIPLIER`). */
const APPRECIATED_STATUSES = ['completed', 'caughtUp', 'reading'];

/** Statuts qui valent « je suis au bout » (suites proposables). */
const FINISHED_STATUSES = ['completed', 'caughtUp'];

/** Note perso à partir de laquelle une œuvre compte, quel que soit le statut. */
export const APPRECIATED_RATING_FLOOR = 7;

const STATUS_MULTIPLIER: Record<string, number> = {
  completed: 1.5,
  caughtUp: 1.3,
  reading: 1.2,
  readLater: 0.8,
};

const RECENCY_HALF_LIFE_DAYS = 365;

/**
 * Contextes des œuvres **appréciées** de la bibliothèque — les seules
 * autorisées à propager leur voisinage.
 *
 * « Appréciée » = statut `completed` / `caughtUp` / `reading`, ou note perso
 * ≥ 7 quel que soit le statut. `readLater` non noté en est exclu : un titre
 * simplement planifié n'a pas encore été lu, ce n'est pas un signal de goût
 * — et c'est justement le genre d'entrée qui polluait le pool.
 */
export function buildGraphSourceContexts(
  userMangas: UserManga[],
  now: number = Date.now(),
): Map<string, GraphSourceContext> {
  const contexts = new Map<string, GraphSourceContext>();
  for (const um of userMangas) {
    const muId = um.manga?.mu_id;
    if (!muId) continue;
    const rating = Number(um.user_rating) || 0;
    const appreciated =
      APPRECIATED_STATUSES.includes(um.readingStatus) ||
      rating >= APPRECIATED_RATING_FLOOR;
    if (!appreciated) continue;

    const ratingMultiplier = rating > 0 ? rating / 5.0 : 1.0;
    const statusMultiplier = STATUS_MULTIPLIER[um.readingStatus] ?? 1.0;
    const ageDays = um.adding_date
      ? (now - um.adding_date.getTime()) / 86_400_000
      : 0;
    contexts.set(muId, {
      muId,
      multiplier:
        ratingMultiplier *
        statusMultiplier *
        Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS),
      finished: FINISHED_STATUSES.includes(um.readingStatus),
    });
  }
  return contexts;
}

/**
 * Transforme des liens bruts en contributions comparables au scoring
 * historique.
 *
 * @param rows     Liens `category` / `related` des sources de la biblio.
 * @param contexts Sortie de `buildGraphSourceContexts`.
 * @param excluded Bibliothèque ∪ titres écartés — exclusion stricte.
 */
export function scoreGraphLinks(
  rows: GraphLinkRow[],
  contexts: Map<string, GraphSourceContext>,
  excluded: Set<string>,
): GraphContribution[] {
  const bySource = new Map<string, GraphLinkRow[]>();
  for (const row of rows) {
    if (!contexts.has(row.source_mu_id)) continue;
    if (row.recommended_mu_id === row.source_mu_id) continue;
    if (excluded.has(row.recommended_mu_id)) continue;
    const list = bySource.get(row.source_mu_id);
    if (list) list.push(row);
    else bySource.set(row.source_mu_id, [row]);
  }

  const contributions: GraphContribution[] = [];
  for (const [sourceMuId, links] of bySource) {
    const context = contexts.get(sourceMuId) as GraphSourceContext;
    contributions.push(...scoreCategoryLinks(sourceMuId, links, context));
    contributions.push(...scoreRelatedLinks(sourceMuId, links, context));
  }
  return contributions;
}

/** Voisins `category` d'une source, normalisés par le poids max du groupe. */
function scoreCategoryLinks(
  sourceMuId: string,
  links: GraphLinkRow[],
  context: GraphSourceContext,
): GraphContribution[] {
  const category = links
    .filter((row) => row.kind === 'category' && row.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_CATEGORY_LINKS_PER_SOURCE);
  if (category.length === 0) return [];

  const maxWeight = category[0].weight;
  return category.map((row) => ({
    muId: row.recommended_mu_id,
    sourceMuId,
    kind: 'category' as const,
    score:
      CATEGORY_TOP_CONTRIBUTION * (row.weight / maxWeight) * context.multiplier,
  }));
}

/** Liens de parenté recevables (cf. doc de module). */
function scoreRelatedLinks(
  sourceMuId: string,
  links: GraphLinkRow[],
  context: GraphSourceContext,
): GraphContribution[] {
  if (!context.finished) return [];
  return links
    .filter(
      (row) =>
        row.kind === 'related' && isDiscoverableRelation(row.relation_type),
    )
    .map((row) => ({
      muId: row.recommended_mu_id,
      sourceMuId,
      kind: 'related' as const,
      score: RELATED_CONTRIBUTION * context.multiplier,
    }));
}
