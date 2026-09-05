import { CatalogShard, typeYearShardJobName } from './catalog-shard';
import { CatalogSyncState } from './catalog-sync-state.entity';

/**
 * Planification PURE du rattrapage de `manga.type` — aucune I/O, testable
 * sans repository ni réseau (même doctrine que `CatalogShardPlannerService`).
 *
 * File = pour chaque année, de la courante au plancher (desc), un shard par
 * type ciblé (`type:Manhwa:year:2015`, puis `type:Manhua:year:2015`…). Les
 * années récentes d'abord : c'est là que se concentrent les manhwa/manhua
 * (2015 : 561 manhwa ; le webtoon coréen explose après 2018) et donc les
 * lignes qui manquent le plus aux recommandations.
 *
 * **Un shard terminé est définitivement sorti de la file** (pas de fenêtre de
 * rafraîchissement) : ce job est un rattrapage ponctuel. Une fois le stock
 * couvert, ce sont les shards annuels du catalogue nightly — dont l'upsert
 * persiste désormais `record.type` — qui maintiennent la colonne à jour au
 * fil de leurs propres rafraîchissements (7 j / 30 j). Faire tourner le
 * rattrapage en boucle recoûterait ~250 pages par cycle pour rien.
 */
export function planTypeBackfillQueue(
  states: CatalogSyncState[],
  types: readonly string[],
  currentYear: number,
  yearFloor: number,
): CatalogShard[] {
  const completed = new Set(
    states
      .filter((s) => s.completed_at !== null && s.completed_at !== undefined)
      .map((s) => s.job_name),
  );
  const queue: CatalogShard[] = [];
  for (let year = currentYear; year >= yearFloor; year--) {
    for (const type of types) {
      const jobName = typeYearShardJobName(type, year);
      if (completed.has(jobName)) continue;
      queue.push({
        jobName,
        kind: 'type_year',
        // Niveau 1 = pas de sous-découpage : un type × une année reste très
        // loin du plafond MU de 10 000 hits (mesuré : 561 pour Manhwa 2015).
        level: 1,
        orderby: 'rating',
        year,
        type,
      });
    }
  }
  return queue;
}

/**
 * Types ciblés depuis la config (`CATALOG_TYPE_BACKFILL_TYPES`, séparés par
 * des virgules), ou la liste par défaut si la variable est absente/vide.
 */
export function parseBackfillTypes(
  raw: string | undefined,
  fallback: readonly string[],
): string[] {
  const parsed = (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return parsed.length > 0 ? parsed : [...fallback];
}
