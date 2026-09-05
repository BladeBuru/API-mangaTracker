import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import {
  buildHomeFixture,
  FakeHomeSectionQueryBuilder,
} from '../../../../test/fixtures/home-sections.fixture';
import { HomeSectionsController } from './home-sections.controller';
import { HomeSectionsService } from './home-sections.service';
import { HomeSectionQueryBuilder } from './home-sections.query';

const NOW = new Date('2026-09-05T10:00:00Z');

/** Clés EXACTES du contrat partagé avec le client Flutter. */
const SECTION_KEYS = ['id', 'kind', 'params', 'items'];
const PAGE_KEYS = ['id', 'kind', 'params', 'page', 'limit', 'total', 'items'];
const ITEM_REQUIRED_KEYS = [
  'muId',
  'title',
  'year',
  'mediumCoverUrl',
  'largeCoverUrl',
  'rating',
];

/**
 * Contrat HTTP de l'accueil, vérifié à travers le vrai controller et le vrai
 * service (fixtures en mémoire). Le client Flutter est codé en parallèle sur
 * ce contrat : toute divergence doit casser ici.
 */
describe('HomeSectionsController — contrat', () => {
  let controller: HomeSectionsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HomeSectionsController],
      providers: [
        HomeSectionsService,
        {
          provide: HomeSectionQueryBuilder,
          useValue: new FakeHomeSectionQueryBuilder(buildHomeFixture()),
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'NODE_ENV' ? 'test' : undefined),
          },
        },
      ],
    }).compile();
    controller = module.get<HomeSectionsController>(HomeSectionsController);
    module.get<HomeSectionsService>(HomeSectionsService).now = () => NOW;
  });

  it('GET /mangas/home/sections → { generatedAt, sections[{id, kind, params, items}] }', async () => {
    const body = await controller.getSections({ limit: 20 });

    expect(Object.keys(body).sort()).toEqual(['generatedAt', 'sections']);
    expect(new Date(body.generatedAt).toISOString()).toBe(body.generatedAt);
    expect(body.sections.length).toBeGreaterThan(0);
    for (const section of body.sections) {
      expect(Object.keys(section).sort()).toEqual([...SECTION_KEYS].sort());
      // Pas de titre : le client traduit `kind` + `params`.
      expect(section).not.toHaveProperty('title');
      expect(typeof section.id).toBe('string');
      expect(section.items.length).toBeGreaterThanOrEqual(5);
      expect(section.items.length).toBeLessThanOrEqual(20);
      switch (section.kind) {
        case 'type':
          expect(section.id).toBe(`type:${section.params.type}`);
          break;
        case 'genre':
          expect(section.id).toBe(`genre:${section.params.genre}`);
          break;
        case 'year':
          expect(typeof section.params.year).toBe('number');
          expect(section.id).toBe(`year:${section.params.year}`);
          break;
        default:
          expect(section.params).toEqual({});
          expect(section.id).toBe(section.kind);
      }
      for (const item of section.items) {
        for (const key of ITEM_REQUIRED_KEYS) expect(item).toHaveProperty(key);
        expect(typeof item.muId).toBe('number');
        expect(typeof item.rating).toBe('number');
        expect(typeof item.year).toBe('number');
      }
    }
  });

  it('GET /mangas/home/sections sans limit → 20 titres par section (défaut)', async () => {
    const body = await controller.getSections({});
    for (const section of body.sections) {
      expect(section.items.length).toBeLessThanOrEqual(20);
    }
  });

  it('GET /mangas/home/sections/:id → { id, kind, params, page, limit, total, items }', async () => {
    const body = await controller.getSection('genre:Action', {
      page: 1,
      limit: 40,
    });

    expect(Object.keys(body).sort()).toEqual([...PAGE_KEYS].sort());
    expect(body).toMatchObject({
      id: 'genre:Action',
      kind: 'genre',
      params: { genre: 'Action' },
      page: 1,
      limit: 40,
    });
    expect(typeof body.total).toBe('number');
    expect(body.items.length).toBeLessThanOrEqual(40);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('GET /mangas/home/sections/:id sans query → page 1, limit 40', async () => {
    const body = await controller.getSection('latest', {});
    expect(body.page).toBe(1);
    expect(body.limit).toBe(40);
  });

  it('GET /mangas/home/sections/:id inconnu → 404', async () => {
    await expect(
      controller.getSection('nope', { page: 1, limit: 20 }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
