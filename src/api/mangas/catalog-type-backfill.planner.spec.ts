import { CatalogSyncState } from './catalog-sync-state.entity';
import {
  parseBackfillTypes,
  planTypeBackfillQueue,
} from './catalog-type-backfill.planner';
import { TYPE_BACKFILL_DEFAULT_TYPES } from './manga-type';

function state(
  jobName: string,
  completedAt: Date | null = null,
): CatalogSyncState {
  const s = new CatalogSyncState();
  s.job_name = jobName;
  s.completed_at = completedAt;
  s.last_completed_page = 0;
  return s;
}

describe('planTypeBackfillQueue', () => {
  it('produit un shard par type et par année, années décroissantes, Manhwa avant Manhua', () => {
    const queue = planTypeBackfillQueue(
      [],
      TYPE_BACKFILL_DEFAULT_TYPES,
      2026,
      2024,
    );

    expect(queue.map((s) => s.jobName)).toEqual([
      'type:Manhwa:year:2026',
      'type:Manhua:year:2026',
      'type:Manhwa:year:2025',
      'type:Manhua:year:2025',
      'type:Manhwa:year:2024',
      'type:Manhua:year:2024',
    ]);
  });

  it('décrit des shards `type_year` de niveau 1 avec le filtre type + year', () => {
    const [shard] = planTypeBackfillQueue([], ['Manhwa'], 2015, 2015);

    expect(shard).toEqual({
      jobName: 'type:Manhwa:year:2015',
      kind: 'type_year',
      level: 1,
      orderby: 'rating',
      year: 2015,
      type: 'Manhwa',
    });
  });

  it('exclut définitivement les shards terminés (rattrapage ponctuel, pas de fenêtre de rafraîchissement)', () => {
    const states = [
      state('type:Manhwa:year:2026', new Date('2020-01-01')), // terminé il y a longtemps → quand même exclu
      state('type:Manhua:year:2026', null), // en cours → conservé
      state('catalog:year:2026', new Date()), // shard catalogue : sans rapport
    ];

    const queue = planTypeBackfillQueue(
      states,
      TYPE_BACKFILL_DEFAULT_TYPES,
      2026,
      2026,
    );

    expect(queue.map((s) => s.jobName)).toEqual(['type:Manhua:year:2026']);
  });

  it('respecte le plancher d’année', () => {
    const queue = planTypeBackfillQueue([], ['Manhwa'], 1952, 1950);
    expect(queue.map((s) => s.year)).toEqual([1952, 1951, 1950]);
  });
});

describe('parseBackfillTypes', () => {
  it('retombe sur la liste par défaut si la variable est absente ou vide', () => {
    expect(parseBackfillTypes(undefined, TYPE_BACKFILL_DEFAULT_TYPES)).toEqual([
      'Manhwa',
      'Manhua',
    ]);
    expect(parseBackfillTypes('  ', TYPE_BACKFILL_DEFAULT_TYPES)).toEqual([
      'Manhwa',
      'Manhua',
    ]);
  });

  it('lit une liste séparée par des virgules, trimée', () => {
    expect(
      parseBackfillTypes('Manhwa, Manhua ,OEL', TYPE_BACKFILL_DEFAULT_TYPES),
    ).toEqual(['Manhwa', 'Manhua', 'OEL']);
  });
});
