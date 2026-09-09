/**
 * Fenêtre de pagination et **liste canonique** des recommandations —
 * fonctions PURES (aucune I/O).
 *
 * ## Le bug corrigé (prod, rapporté le 2026-09-09)
 *
 * « Les recommandations de la page d'accueil, une fois que je déplie, ne sont
 * pas forcément les mêmes dans l'ordre. » L'accueil demande `limit=10`, la
 * page « Voir tout » `limit=50` — et `limit`/`offset` faisaient partie de la
 * clé de cache. Deux tailles de page = deux entrées de cache = **deux calculs
 * complets et indépendants**, chacun ré-interrogeant la base, ré-additionnant
 * les scores et retriant. Les deux listes n'avaient aucune raison structurelle
 * de partager leur préfixe.
 *
 * ## Le principe
 *
 * Une seule unité de calcul par `(utilisateur, filtre de genre)` : la **liste
 * canonique**, bornée à `canonicalMaxItems()`. C'est elle qui est mise en
 * cache ; la pagination n'est plus qu'un `slice` appliqué APRÈS le cache, au
 * hit comme au miss. Toute taille de page devient un préfixe de la même
 * liste, donc `limit=10` est exactement les 10 premiers de `limit=50`.
 *
 * Le contrat client ne bouge pas : mêmes paramètres, même forme de réponse.
 */

/** Limite max d'une page. **2026-05-19** : 100 → 500. */
export const RECO_MAX_LIMIT = 500;

/** Plancher d'une page : `limit=0` ou négatif n'atteint jamais un `slice`. */
export const RECO_MIN_LIMIT = 1;

/** Valeur de repli quand `limit` n'est pas un nombre exploitable. */
export const RECO_DEFAULT_LIMIT = 50;

/**
 * Taille par défaut de la liste canonique.
 *
 * Égale à `RECO_MAX_LIMIT` : une requête `limit=500&offset=0` doit rester
 * servie en entier — descendre sous cette valeur tronquerait une page que
 * l'API accepte déjà aujourd'hui.
 *
 * Conséquence assumée : au-delà de `offset + limit > 500`, la réponse est
 * vide là où l'ancienne pagination pouvait encore rendre des titres. Le
 * client Flutter s'arrête proprement (page incomplète → `hasMore = false`).
 * Mesuré en prod le 2026-09-09 : le pool réel de la plus grosse bibliothèque
 * (68 titres) est de ~230 candidats — la borne n'est pas atteinte.
 */
export const RECO_DEFAULT_CANONICAL_MAX_ITEMS = RECO_MAX_LIMIT;

/** Borne haute de sécurité de `RECO_CANONICAL_MAX_ITEMS` (mémoire du cache). */
export const RECO_CANONICAL_MAX_ITEMS_CEILING = 2000;

/**
 * Taille de la liste canonique, configurable par
 * `RECO_CANONICAL_MAX_ITEMS`.
 *
 * Coût mémoire mesuré (prod, 2026-09-09) : un `MangaQuickViewDto` de
 * recommandation pèse ≈ 378 o en JSON, ≈ 460 o en tas Node — soit ≈ 230 Kio
 * pour une liste pleine de 500 entrées, et ≈ 105 Kio pour un pool réel de
 * ~230 candidats. À comparer à AVANT : un utilisateur qui déroulait la liste
 * accumulait déjà une entrée de cache par page (10 pages × 50 cartes = les
 * mêmes 500 cartes, en 10 entrées). Le cache canonique remplace ces N
 * entrées par UNE.
 */
export function recoCanonicalMaxItems(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.RECO_CANONICAL_MAX_ITEMS);
  if (!Number.isFinite(raw)) return RECO_DEFAULT_CANONICAL_MAX_ITEMS;
  return Math.min(
    Math.max(Math.trunc(raw), RECO_MAX_LIMIT),
    RECO_CANONICAL_MAX_ITEMS_CEILING,
  );
}

/** Fenêtre de pagination validée. */
export interface RecoWindow {
  limit: number;
  offset: number;
}

/**
 * Borne la fenêtre demandée par le client.
 *
 * `ParseIntPipe` rejette déjà `limit=abc` (400), mais laissait passer
 * `limit=-1` — qui atteignait `slice(0, -1)` et retirait silencieusement la
 * dernière carte. On borne plutôt que de rejeter : un client existant qui
 * envoie `limit=0` doit continuer à recevoir une réponse valide.
 */
export function clampRecoWindow(limit: number, offset: number): RecoWindow {
  const rawLimit = Number.isFinite(limit)
    ? Math.trunc(limit)
    : RECO_DEFAULT_LIMIT;
  const rawOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0;
  return {
    limit: Math.min(Math.max(rawLimit, RECO_MIN_LIMIT), RECO_MAX_LIMIT),
    offset: Math.max(rawOffset, 0),
  };
}

/** Découpe la liste canonique selon une fenêtre déjà bornée. */
export function paginate<T>(items: T[], window: RecoWindow): T[] {
  return items.slice(window.offset, window.offset + window.limit);
}
