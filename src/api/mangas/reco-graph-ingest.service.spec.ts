import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { MangaRecommendation } from './manga-recommendation.entity';
import { RecoGraphIngestService } from './reco-graph-ingest.service';

/** Une requête jouée par le service, telle que capturée par le faux repo. */
interface RecordedOp {
  kind: 'insert' | 'update';
  values?: Record<string, unknown>[];
  set?: Record<string, unknown>;
  conditions: string[];
  orIgnore: boolean;
  upsertColumns?: string[];
  conflictColumns?: string[];
}

/**
 * Faux repository TypeORM qui enregistre les requêtes construites : on
 * vérifie l'INTENTION SQL (colonnes de conflit, `ON CONFLICT DO NOTHING`,
 * garde `IS NULL`), pas l'implémentation interne du QueryBuilder.
 */
function recordingRepo(ops: RecordedOp[]) {
  return {
    createQueryBuilder: jest.fn(() => {
      const op: RecordedOp = {
        kind: 'insert',
        conditions: [],
        orIgnore: false,
      };
      const qb: Record<string, unknown> = {};
      const chain = (fn?: (...args: unknown[]) => void) =>
        jest.fn((...args: unknown[]) => {
          fn?.(...args);
          return qb;
        });
      Object.assign(qb, {
        insert: chain(() => (op.kind = 'insert')),
        into: chain(),
        values: chain((v) => (op.values = v as Record<string, unknown>[])),
        orIgnore: chain(() => (op.orIgnore = true)),
        orUpdate: chain((cols, conflict) => {
          op.upsertColumns = cols as string[];
          op.conflictColumns = conflict as string[];
        }),
        update: chain(() => (op.kind = 'update')),
        set: chain((s) => (op.set = s as Record<string, unknown>)),
        where: chain((c) => op.conditions.push(String(c))),
        andWhere: chain((c) => op.conditions.push(String(c))),
        execute: jest.fn(async () => {
          ops.push(op);
          return {};
        }),
      });
      return qb;
    }),
  };
}

/** Fiche MU minimale portant les trois voisinages. */
const SOURCE_MU_ID = 15180124327;
const payload = {
  type: 'Manhwa',
  recommendations: [{ series_id: 100, series_name: 'Manuel A', weight: 3 }],
  category_recommendations: [
    {
      series_id: 200,
      series_name: 'Catégorie A',
      weight: 38432,
      series_image: { url: { original: 'o.jpg', thumb: 't.jpg' } },
    },
    { series_id: 201, series_name: 'Catégorie B', weight: 27749 },
  ],
  related_series: [
    {
      related_series_id: 300,
      related_series_name: 'La suite',
      relation_type: 'Sequel',
    },
  ],
};

describe('RecoGraphIngestService', () => {
  let service: RecoGraphIngestService;
  let mangaOps: RecordedOp[];
  let recoOps: RecordedOp[];

  beforeEach(async () => {
    mangaOps = [];
    recoOps = [];
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecoGraphIngestService,
        {
          provide: getRepositoryToken(Manga),
          useValue: recordingRepo(mangaOps),
        },
        {
          provide: getRepositoryToken(MangaRecommendation),
          useValue: recordingRepo(recoOps),
        },
      ],
    }).compile();
    service = module.get<RecoGraphIngestService>(RecoGraphIngestService);
  });

  it('persiste les trois voisinages avec leur `kind`', async () => {
    const outcome = await service.ingestSeriesPayload(SOURCE_MU_ID, payload);

    expect(outcome).toEqual({ manual: 1, category: 2, related: 1, stubs: 4 });

    const inserted = recoOps
      .filter((op) => op.kind === 'insert')
      .flatMap((op) => op.values ?? []);
    expect(inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_mu_id: '15180124327',
          recommended_mu_id: '100',
          kind: 'manual',
          weight: 3,
          relation_type: null,
        }),
        expect.objectContaining({
          recommended_mu_id: '200',
          kind: 'category',
          weight: 38432,
        }),
        expect.objectContaining({
          recommended_mu_id: '300',
          kind: 'related',
          weight: 0,
          relation_type: 'Sequel',
        }),
      ]),
    );
  });

  it("cible le conflit sur (source, kind, cible) — c'est ce qui préserve les liens existants", async () => {
    await service.ingestSeriesPayload(SOURCE_MU_ID, payload);

    const upserts = recoOps.filter((op) => op.conflictColumns);
    expect(upserts.length).toBeGreaterThan(0);
    for (const op of upserts) {
      // Sans `kind` dans la cible du conflit, un lien `category` écraserait
      // le lien `manual` de la même paire — les 17 825 liens historiques
      // seraient perdus au premier passage du job.
      expect(op.conflictColumns).toEqual([
        'source_mu_id',
        'kind',
        'recommended_mu_id',
      ]);
      expect(op.upsertColumns).toEqual([
        'recommended_title',
        'relation_type',
        'weight',
        'updated_at',
      ]);
    }
  });

  it('crée les stubs `manga` sans jamais écraser une fiche existante', async () => {
    await service.ingestSeriesPayload(SOURCE_MU_ID, payload);

    const stubInsert = mangaOps.find((op) => op.kind === 'insert');
    expect(stubInsert?.orIgnore).toBe(true);
    expect(stubInsert?.values?.map((v) => v.mu_id)).toEqual([
      '100',
      '200',
      '201',
      '300',
    ]);
    // Le lien `related` n'apporte pas de cover : stub sans image, pas de
    // `undefined` qui casserait l'insert.
    expect(stubInsert?.values?.[3]).toEqual({
      mu_id: '300',
      title: 'La suite',
      small_cover_url: null,
      medium_cover_url: null,
    });
  });

  it('ne complète les covers que des lignes qui n’en ont pas', async () => {
    await service.ingestSeriesPayload(SOURCE_MU_ID, payload);

    const coverUpdates = mangaOps.filter(
      (op) => op.kind === 'update' && 'medium_cover_url' in (op.set ?? {}),
    );
    expect(coverUpdates).toHaveLength(1);
    expect(coverUpdates[0].conditions).toContain('medium_cover_url IS NULL');
  });

  it('écrit le `type` de la source sans jamais écraser une valeur connue', async () => {
    await service.ingestSeriesPayload(SOURCE_MU_ID, payload);

    const typeUpdate = mangaOps.find(
      (op) => op.kind === 'update' && (op.set as { type?: string })?.type,
    );
    expect(typeUpdate?.set).toEqual({ type: 'Manhwa' });
    expect(typeUpdate?.conditions).toContain('type IS NULL');
  });

  it('est idempotent : deux ingestions identiques produisent les mêmes upserts', async () => {
    const first = await service.ingestSeriesPayload(SOURCE_MU_ID, payload);
    const opsAfterFirst = recoOps.length;
    const second = await service.ingestSeriesPayload(SOURCE_MU_ID, payload);

    expect(second).toEqual(first);
    expect(recoOps.length).toBe(opsAfterFirst * 2);
    // Aucune suppression : le service n'émet que des INSERT ... ON CONFLICT.
    expect(recoOps.every((op) => op.kind === 'insert')).toBe(true);
  });

  it('ne touche à rien quand la fiche ne contient aucun voisinage', async () => {
    const outcome = await service.ingestSeriesPayload(SOURCE_MU_ID, {});

    expect(outcome).toEqual({ manual: 0, category: 0, related: 0, stubs: 0 });
    expect(recoOps).toHaveLength(0);
    expect(mangaOps).toHaveLength(0);
  });

  it('saveManualLinks n’écrit que des liens `manual` (chemin historique)', async () => {
    await service.saveManualLinks(SOURCE_MU_ID, [
      {
        seriesId: 100,
        title: 'Manuel A',
        weight: 3,
        smallCoverUrl: null,
        mediumCoverUrl: null,
      },
    ]);

    const kinds = recoOps
      .flatMap((op) => op.values ?? [])
      .map((row) => row.kind);
    expect(kinds).toEqual(['manual']);
  });
});
