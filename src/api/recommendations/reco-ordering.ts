/**
 * Comparateurs **totaux** partagés par tous les chemins de recommandation —
 * fonctions PURES (aucune I/O).
 *
 * ## Pourquoi
 *
 * Partout où un tri par score précède une troncature (`slice`), un tri
 * *partiel* (score seul) rend le résultat indéterminé dès que deux candidats
 * sont à égalité : `Array.prototype.sort` est stable, mais il ne l'est que
 * par rapport à l'ordre d'ENTRÉE — or cet ordre venait d'une `Map` dont
 * l'insertion dépend d'une course `Promise.all`, ou d'un `getRawMany()` sans
 * `ORDER BY`. Deux requêtes identiques pouvaient donc rendre deux listes
 * différentes, et deux tailles de page ne partageaient pas leur préfixe.
 *
 * Le départage retenu est le `mu_id` croissant : identifiant immuable, connu
 * partout, indépendant de toute donnée que les tâches de fond viennent
 * réécrire (`type`, `year`, `rating`). **Il ne modifie aucun classement à
 * scores distincts** — il ne fait que fixer l'arbitrage des ex æquo.
 */

/**
 * Compare deux identifiants de façon déterministe.
 *
 * Les `mu_id` sont des chaînes de chiffres : on les compare numériquement
 * (`'9' < '10'`) et on retombe sur l'ordre lexicographique pour tout le
 * reste (noms de genres, clés non numériques) et pour les cas où deux
 * chaînes distinctes valent le même nombre (`'01'` / `'1'`).
 */
export function compareIdAsc(a: string | number, b: string | number): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
    return na < nb ? -1 : 1;
  }
  const sa = String(a);
  const sb = String(b);
  if (sa === sb) return 0;
  return sa < sb ? -1 : 1;
}

/**
 * Ordre total « valeur décroissante, puis identifiant croissant ».
 *
 * @param valueOf score (ou poids, ou note) à maximiser.
 * @param idOf    identifiant de départage — stable dans le temps.
 */
export function byValueDescThenId<T>(
  valueOf: (item: T) => number,
  idOf: (item: T) => string | number,
): (a: T, b: T) => number {
  return (a, b) => {
    const diff = valueOf(b) - valueOf(a);
    if (diff !== 0 && !Number.isNaN(diff)) return diff;
    return compareIdAsc(idOf(a), idOf(b));
  };
}

/**
 * Même ordre total pour les entrées `[clé, valeur]` d'une `Map`
 * (contributions par manga source, occurrences par genre…), dont l'ordre
 * d'itération est un ordre d'insertion, donc non reproductible.
 */
export function compareEntryValueDescThenKey(
  a: readonly [string, number],
  b: readonly [string, number],
): number {
  const diff = b[1] - a[1];
  if (diff !== 0 && !Number.isNaN(diff)) return diff;
  return compareIdAsc(a[0], b[0]);
}
