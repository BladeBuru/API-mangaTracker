import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  buildHomeFixture,
  EXCLUDED_FIXTURE_IDS,
  FakeHomeSectionQueryBuilder,
} from '../../../../test/fixtures/home-sections.fixture';
import { buildHomeSectionDefs } from './home-section.catalog';
import { HomeSectionsService } from './home-sections.service';
import { HomeSectionQueryBuilder } from './home-sections.query';

const NOW = new Date('2026-09-05T10:00:00Z');

describe('HomeSectionsService', () => {
  let service: HomeSectionsService;
  let queries: FakeHomeSectionQueryBuilder;
  let clock: Date;

  async function build(): Promise<void> {
    queries = new FakeHomeSectionQueryBuilder(buildHomeFixture());
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HomeSectionsService,
        { provide: HomeSectionQueryBuilder, useValue: queries },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'NODE_ENV' ? 'test' : undefined),
          },
        },
      ],
    }).compile();
    service = module.get<HomeSectionsService>(HomeSectionsService);
    clock = new Date(NOW);
    service.now = () => clock;
  }

  beforeEach(build);

  describe('GET /mangas/home/sections', () => {
    it('renvoie les sections dans l’ordre serveur, avec exactement `limit` titres chacune', async () => {
      const home = await service.getHome(5);

      expect(home.generatedAt).toBe(NOW.toISOString());
      const ids = home.sections.map((s) => s.id);
      // Les sections servies sont une sous-suite de l'ordre serveur.
      const order = buildHomeSectionDefs(NOW).map((d) => d.id);
      expect(ids).toEqual(order.filter((id) => ids.includes(id)));
      for (const id of [
        'latest',
        'popular',
        'community',
        'top_rated',
        'type:Manhwa',
        'type:Manhua',
        'type:Manga',
        'genre:Action',
        'year:2026',
        'hidden_gems',
      ]) {
        expect(ids).toContain(id);
      }
      expect(ids[ids.length - 1]).toBe('hidden_gems');
      for (const section of home.sections) {
        expect(section.items).toHaveLength(5);
      }
    });

    it('déduplique inter-sections : un titre n’apparaît que dans la première section qui le sélectionne', async () => {
      const home = await service.getHome(20);

      const seen = new Map<number, string>();
      for (const section of home.sections) {
        for (const item of section.items) {
          expect(seen.has(item.muId)).toBe(false);
          seen.set(item.muId, section.id);
        }
      }
    });

    it('omet les sections de moins de 5 titres (ex. type:Manhua quand le type n’est pas encore rattrapé)', async () => {
      // Fixture réduite : 3 manhua seulement.
      const fixture = buildHomeFixture();
      let kept = 0;
      fixture.mangas = fixture.mangas.filter(
        (m) => m.type !== 'Manhua' || kept++ < 3,
      );
      queries = new FakeHomeSectionQueryBuilder(fixture);
      service = new HomeSectionsService(
        queries as unknown as HomeSectionQueryBuilder,
        { get: () => 'test' } as unknown as ConfigService,
      );
      service.now = () => clock;

      const home = await service.getHome(5);

      const ids = home.sections.map((s) => s.id);
      expect(ids).not.toContain('type:Manhua');
      expect(ids).toContain('type:Manhwa');
      // Aucune section servie sous le seuil.
      for (const section of home.sections) {
        expect(section.items.length).toBeGreaterThanOrEqual(5);
      }
    });

    it('exclut NSFW, titres sans cover et sans genres de toutes les sections', async () => {
      const home = await service.getHome(40);
      const all = home.sections.flatMap((s) => s.items);
      expect(all.length).toBeGreaterThan(0);
      for (const item of all) {
        expect(EXCLUDED_FIXTURE_IDS).not.toContain(item.muId);
        expect(item.mediumCoverUrl).not.toBe('');
      }
    });

    it('expose `type` et `genres` sur les cartes quand ils sont connus', async () => {
      const home = await service.getHome(5);
      const manhwa = home.sections.find((s) => s.id === 'type:Manhwa');
      expect(manhwa).toBeDefined();
      for (const item of manhwa!.items) {
        expect(item.type).toBe('Manhwa');
        expect(Array.isArray(item.genres)).toBe(true);
      }
    });

    it('une section en échec SQL est omise, les autres sont servies', async () => {
      queries.failingIds.add('popular');

      const home = await service.getHome(5);

      expect(home.sections.map((s) => s.id)).not.toContain('popular');
      expect(home.sections.map((s) => s.id)).toContain('latest');
    });
  });

  describe('cache ~10 min, stale-while-revalidate', () => {
    it('sert la 2e requête depuis le cache sans requêter la base', async () => {
      await service.getHome(20);
      const built = queries.builtIds.length;

      const again = await service.getHome(20);

      expect(queries.builtIds.length).toBe(built);
      expect(again.generatedAt).toBe(NOW.toISOString());
    });

    it('une variante différente (limit) est calculée séparément', async () => {
      await service.getHome(20);
      const built = queries.builtIds.length;
      await service.getHome(10);
      expect(queries.builtIds.length).toBeGreaterThan(built);
    });

    it('après le TTL, sert l’ancienne valeur immédiatement et reconstruit en arrière-plan', async () => {
      await service.getHome(20);
      const built = queries.builtIds.length;
      clock = new Date(NOW.getTime() + HomeSectionsService.CACHE_TTL_MS + 1);

      const stale = await service.getHome(20);
      expect(stale.generatedAt).toBe(NOW.toISOString()); // ancienne valeur
      // Reconstruction lancée (requêtes émises), une seule à la fois.
      await service.getHome(20);
      await new Promise((r) => setImmediate(r));
      expect(queries.builtIds.length).toBe(built * 2);

      const fresh = await service.getHome(20);
      expect(fresh.generatedAt).toBe(clock.toISOString());
    });
  });

  describe('GET /mangas/home/sections/:id', () => {
    it('renvoie l’enveloppe paginée du contrat', async () => {
      const page = await service.getSection('type:Manhwa', 2, 5);

      expect(page).toMatchObject({
        id: 'type:Manhwa',
        kind: 'type',
        params: { type: 'Manhwa' },
        page: 2,
        limit: 5,
        total: 80,
      });
      expect(page.items).toHaveLength(5);
      // Page 2 = titres 6..10 du tri par note décroissante.
      const first = await service.getSection('type:Manhwa', 1, 5);
      expect(first.items.map((i) => i.muId)).not.toEqual(
        page.items.map((i) => i.muId),
      );
      expect(first.items[0].rating).toBeGreaterThanOrEqual(
        page.items[0].rating,
      );
    });

    it('normalise l’id (type:manhwa → type:Manhwa) et la page de détail ne déduplique pas', async () => {
      const page = await service.getSection('type:manhwa', 1, 40);
      expect(page.id).toBe('type:Manhwa');
      expect(page.total).toBe(80);
      expect(page.items).toHaveLength(40);
    });

    it('year:<Y> porte `year` en nombre', async () => {
      const page = await service.getSection('year:2016', 1, 40);
      expect(page.params).toEqual({ year: 2016 });
      expect(page.total).toBeGreaterThan(0);
    });

    it('404 sur un id inconnu', async () => {
      await expect(service.getSection('unknown', 1, 20)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        service.getSection('genre:Adult', 1, 20),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
