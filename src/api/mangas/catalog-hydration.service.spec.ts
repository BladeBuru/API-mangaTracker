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

    it('sélectionne aussi les fiches sans titres alternatifs (associated)', async () => {
      await service.hydrateIncompleteRows(10);

      expect(whereClauses()).toContain('m.associated IS NULL');
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
  /**
   * Le point le plus important du chantier « titres alternatifs » : `associated`
   * n'existe que sur `/v1/series/{id}`, exactement l'appel que ce job fait
   * déjà. Un job dédié aurait tapé une SECONDE fois la même fiche pour une
   * donnée reçue dans la première réponse — le double du budget réseau pour
   * zéro information supplémentaire, sur l'API qu'il faut ménager.
   */
  describe('titres alternatifs — pas de second appel de fiche', () => {
    it("n'appelle getMangaDetails QU'UNE fois par ligne, quel que soit le nombre de champs manquants", async () => {
      selectQb.getMany.mockResolvedValue([stub('100'), stub('200')]);

      await service.hydrateIncompleteRows(2);

      expect(mangasService.getMangaDetails).toHaveBeenCalledTimes(2);
      expect(mangasService.getMangaDetails).toHaveBeenNthCalledWith(1, 100);
      expect(mangasService.getMangaDetails).toHaveBeenNthCalledWith(2, 200);
    });

    it('ne re-sonde jamais une fiche déjà enrichie', async () => {
      // Le filtrage se fait en SQL : une ligne complète (associated compris)
      // ne sort pas du SELECT, donc aucun appel réseau n'est émis pour elle.
      selectQb.getMany.mockResolvedValue([]);

      const hydrated = await service.hydrateIncompleteRows(800);

      expect(mangasService.getMangaDetails).not.toHaveBeenCalled();
      expect(hydrated).toBe(0);
    });

    it('respecte le budget nocturne même avec le critère élargi', async () => {
      // Le critère élargi fait bondir le lot éligible (131 000 fiches à
      // terme) : c'est le LIMIT SQL qui borne le nombre d'appels MU, pas la
      // taille du lot. Sans lui, une nuit taperait MU 131 000 fois.
      selectQb.getMany.mockResolvedValue([stub('1'), stub('2'), stub('3')]);

      await service.hydrateIncompleteRows(3);

      expect(selectQb.limit).toHaveBeenCalledWith(3);
      expect(mangasService.getMangaDetails).toHaveBeenCalledTimes(3);
      // Rythme MU inchangé : 1 appel / 2 s, aucune accélération.
      expect(sleepMock).toHaveBeenCalledTimes(3);
      expect(sleepMock).toHaveBeenCalledWith(2000);
    });
  });

  describe('priorisation par usage réel', () => {
    it('classe bibliothèque utilisateur (0) avant recommandation (1) avant le reste (2)', async () => {
      await service.hydrateIncompleteRows(10);

      const [order] = selectQb.orderBy.mock.calls[0];
      const sql = String(order);
      // Avec 131 000 fiches à couvrir, l'ordre décide de ce que les
      // utilisateurs voient réparé les premières nuits.
      expect(sql).toContain('user_manga um WHERE um.manga_id = m.mu_id');
      expect(sql).toContain('mr.recommended_mu_id = m.mu_id');
      expect(sql.indexOf('user_manga')).toBeLessThan(
        sql.indexOf('manga_recommendation'),
      );
      expect(sql).toContain('THEN 0');
      expect(sql).toContain('THEN 1');
      expect(sql).toContain('ELSE 2');
    });
  });
});
