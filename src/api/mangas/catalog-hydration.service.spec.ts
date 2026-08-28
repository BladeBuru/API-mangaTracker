import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CatalogHydrationService } from './catalog-hydration.service';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { Manga } from './manga.entity';
import { MangasService } from './mangas.service';

/**
 * Tests du job d'hydratation, déplacés depuis `catalog-sync.service.spec.ts`
 * avec l'extraction de `CatalogHydrationService` (découpage du catalogue par
 * année, 2026-08-28). Comportement inchangé.
 */
describe('CatalogHydrationService', () => {
  let service: CatalogHydrationService;
  let stateRepo: { findOneBy: jest.Mock; create: jest.Mock; save: jest.Mock };
  let mangaRepo: { createQueryBuilder: jest.Mock; update: jest.Mock };
  let mangasService: { getMangaDetails: jest.Mock };
  let sleepMock: jest.Mock;
  let selectQb: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    limit: jest.Mock;
    getMany: jest.Mock;
  };

  function stub(muId: string): Manga {
    const manga = new Manga();
    manga.mu_id = muId;
    manga.title = `Stub ${muId}`;
    return manga;
  }

  /** Concatène les fragments SQL passés à where/andWhere. */
  function whereClauses(): string {
    return [
      ...selectQb.where.mock.calls.map((c) => String(c[0])),
      ...selectQb.andWhere.mock.calls.map((c) => String(c[0])),
    ].join(' | ');
  }

  beforeEach(async () => {
    sleepMock = jest.fn().mockResolvedValue(undefined);

    selectQb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };

    stateRepo = {
      findOneBy: jest.fn().mockResolvedValue(null),
      create: jest.fn((partial: Partial<CatalogSyncState>) =>
        Object.assign(new CatalogSyncState(), partial),
      ),
      save: jest.fn((s: CatalogSyncState) => Promise.resolve(s)),
    };

    mangaRepo = {
      createQueryBuilder: jest.fn(() => selectQb),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    mangasService = { getMangaDetails: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogHydrationService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'NODE_ENV' ? 'test' : undefined,
            ),
          },
        },
        { provide: getRepositoryToken(CatalogSyncState), useValue: stateRepo },
        { provide: getRepositoryToken(Manga), useValue: mangaRepo },
        { provide: MangasService, useValue: mangasService },
      ],
    }).compile();

    service = module.get<CatalogHydrationService>(CatalogHydrationService);
    service.sleep = sleepMock;
  });

  it('applique le budget en LIMIT SQL et hydrate via getMangaDetails', async () => {
    selectQb.getMany.mockResolvedValue([stub('100'), stub('200')]);

    const hydrated = await service.hydrateIncompleteRows(2);

    expect(selectQb.limit).toHaveBeenCalledWith(2);
    expect(mangasService.getMangaDetails).toHaveBeenCalledTimes(2);
    expect(mangasService.getMangaDetails).toHaveBeenCalledWith(100);
    expect(mangasService.getMangaDetails).toHaveBeenCalledWith(200);
    expect(hydrated).toBe(2);
    // Rythme : 1 appel / delayMs (défaut 2000 ms).
    expect(sleepMock).toHaveBeenCalledWith(2000);
  });

  it('budget par défaut = CATALOG_SYNC_HYDRATION_BUDGET (800)', async () => {
    selectQb.getMany.mockResolvedValue([]);
    await service.hydrateIncompleteRows();
    expect(selectQb.limit).toHaveBeenCalledWith(800);
  });

  it("un échec getMangaDetails n'interrompt pas la boucle", async () => {
    selectQb.getMany.mockResolvedValue([stub('100'), stub('200')]);
    mangasService.getMangaDetails
      .mockRejectedValueOnce(new Error('MU down'))
      .mockResolvedValueOnce({});

    const hydrated = await service.hydrateIncompleteRows(2);

    expect(mangasService.getMangaDetails).toHaveBeenCalledTimes(2);
    expect(hydrated).toBe(1);
  });

  describe('critère de sélection élargi', () => {
    it('sélectionne toute ligne incomplète, pas seulement genres IS NULL', async () => {
      await service.hydrateIncompleteRows(10);

      const sql = whereClauses();
      expect(sql).toContain('m.genres IS NULL');
      expect(sql).toContain('m.rating IS NULL');
      expect(sql).toContain('m.year IS NULL');
      expect(sql).toContain('m.medium_cover_url IS NULL');
    });

    it('ne trie plus par rating (le biais qui enterrait les lignes à réparer)', async () => {
      await service.hydrateIncompleteRows(10);

      const orderFragments = [
        ...selectQb.orderBy.mock.calls.map((c) => String(c[0])),
        ...selectQb.addOrderBy.mock.calls.map((c) => String(c[0])),
      ].join(' | ');
      expect(orderFragments).not.toContain('m.rating');
    });
  });

  describe('priorisation', () => {
    it("remonte d'abord les mu_id présents dans manga_recommendation", async () => {
      await service.hydrateIncompleteRows(10);

      const [firstOrder, firstDirection] = selectQb.orderBy.mock.calls[0];
      expect(String(firstOrder)).toContain('manga_recommendation');
      expect(String(firstOrder)).toContain('mr.recommended_mu_id = m.mu_id');
      expect(firstDirection).toBe('ASC');
    });

    it('départage ensuite par les lignes jamais tentées (NULLS FIRST)', async () => {
      await service.hydrateIncompleteRows(10);

      const attemptOrder = selectQb.addOrderBy.mock.calls.find((c) =>
        String(c[0]).includes('hydration_attempted_at'),
      );
      expect(attemptOrder).toBeDefined();
      expect(attemptOrder[1]).toBe('ASC');
      expect(attemptOrder[2]).toBe('NULLS FIRST');
    });
  });

  describe('garde anti-boucle', () => {
    it('exclut les lignes tentées il y a moins de 30 jours', async () => {
      const before = Date.now();
      await service.hydrateIncompleteRows(10);

      expect(whereClauses()).toContain('m.hydration_attempted_at IS NULL');
      expect(whereClauses()).toContain(
        'm.hydration_attempted_at < :retryBefore',
      );

      const params = selectQb.andWhere.mock.calls.find((c) =>
        String(c[0]).includes('hydration_attempted_at'),
      )[1] as { retryBefore: Date };
      const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
      // Fenêtre de 30 jours dans le passé (tolérance d'exécution : 5 s).
      expect(before - params.retryBefore.getTime()).toBeGreaterThanOrEqual(
        thirtyDaysMs,
      );
      expect(before - params.retryBefore.getTime()).toBeLessThan(
        thirtyDaysMs + 5000,
      );
    });

    it('horodate hydration_attempted_at après CHAQUE tentative, succès comme échec', async () => {
      selectQb.getMany.mockResolvedValue([stub('100'), stub('200')]);
      mangasService.getMangaDetails
        .mockRejectedValueOnce(new Error('MU down'))
        .mockResolvedValueOnce({});

      await service.hydrateIncompleteRows(2);

      // Sans ce marquage sur l'échec, un titre que MU ne peut pas compléter
      // serait re-sélectionné chaque nuit → budget brûlé en boucle.
      expect(mangaRepo.update).toHaveBeenCalledTimes(2);
      expect(mangaRepo.update).toHaveBeenCalledWith(
        { mu_id: '100' },
        { hydration_attempted_at: expect.any(Date) },
      );
      expect(mangaRepo.update).toHaveBeenCalledWith(
        { mu_id: '200' },
        { hydration_attempted_at: expect.any(Date) },
      );
    });

    it("un échec d'horodatage n'interrompt pas la boucle", async () => {
      selectQb.getMany.mockResolvedValue([stub('100'), stub('200')]);
      mangaRepo.update.mockRejectedValue(new Error('DB down'));

      const hydrated = await service.hydrateIncompleteRows(2);

      expect(hydrated).toBe(2);
      expect(mangasService.getMangaDetails).toHaveBeenCalledTimes(2);
    });
  });
});
