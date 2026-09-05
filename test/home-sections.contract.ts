/**
 * Script de vérification du CONTRAT de l'accueil « façon Netflix »
 * (`GET /mangas/home/sections`, `GET /mangas/home/sections/:id`) sur
 * fixtures en mémoire — sans base de données ni serveur HTTP.
 *
 *   npm run verify:home-contract
 *
 * Le client Flutter est développé en parallèle sur ce contrat : le script
 * échoue (exit 1) dès qu'une clé, un type ou une règle d'assemblage dévie.
 * Il imprime aussi un extrait de réponse réel pour relecture humaine.
 */
import 'reflect-metadata';
import * as assert from 'assert';
import { ConfigService } from '@nestjs/config';
import { HomeSectionsController } from '../src/api/mangas/home/home-sections.controller';
import { HomeSectionsService } from '../src/api/mangas/home/home-sections.service';
import { HomeSectionQueryBuilder } from '../src/api/mangas/home/home-sections.query';
import {
  buildHomeFixture,
  FakeHomeSectionQueryBuilder,
} from './fixtures/home-sections.fixture';

const NOW = new Date('2026-09-05T10:00:00.000Z');
const KINDS = new Set([
  'latest',
  'popular',
  'top_rated',
  'type',
  'genre',
  'year',
  'community',
  'hidden_gems',
]);

function assertItem(item: Record<string, unknown>, where: string): void {
  for (const key of [
    'muId',
    'title',
    'year',
    'mediumCoverUrl',
    'largeCoverUrl',
    'rating',
  ]) {
    assert.ok(key in item, `${where}: clé « ${key} » manquante sur une carte`);
  }
  assert.strictEqual(
    typeof item.muId,
    'number',
    `${where}: muId doit être un nombre`,
  );
  assert.strictEqual(
    typeof item.title,
    'string',
    `${where}: title doit être une chaîne`,
  );
  assert.strictEqual(
    typeof item.year,
    'number',
    `${where}: year doit être un nombre`,
  );
  assert.strictEqual(
    typeof item.rating,
    'number',
    `${where}: rating doit être un nombre`,
  );
  if ('type' in item) assert.strictEqual(typeof item.type, 'string');
  if ('genres' in item) assert.ok(Array.isArray(item.genres));
}

async function main(): Promise<void> {
  const fixture = buildHomeFixture({ currentYear: NOW.getFullYear() });
  const service = new HomeSectionsService(
    new FakeHomeSectionQueryBuilder(
      fixture,
    ) as unknown as HomeSectionQueryBuilder,
    { get: () => 'test' } as unknown as ConfigService,
  );
  service.now = () => NOW;
  const controller = new HomeSectionsController(service);
  let checks = 0;
  const ok = (label: string) => {
    checks += 1;
    process.stdout.write(`  ✓ ${label}\n`);
  };

  // ── GET /mangas/home/sections?limit=20 ─────────────────────────────────
  const home = await controller.getSections({ limit: 20 });
  assert.deepStrictEqual(Object.keys(home).sort(), ['generatedAt', 'sections']);
  assert.strictEqual(
    new Date(home.generatedAt).toISOString(),
    home.generatedAt,
  );
  ok('sections : enveloppe { generatedAt (ISO), sections }');

  assert.ok(
    home.sections.length >= 8,
    'au moins 8 sections attendues sur la fixture',
  );
  const seen = new Map<number, string>();
  let previousIndex = -1;
  const expectedOrder = [
    'latest',
    'popular',
    'community',
    'top_rated',
    'type:',
    'genre:',
    'year:',
    'hidden_gems',
  ];
  for (const section of home.sections) {
    const s = section as unknown as Record<string, unknown>;
    assert.deepStrictEqual(
      Object.keys(s).sort(),
      ['id', 'items', 'kind', 'params'],
      `section ${section.id} : clés exactes {id, kind, params, items}`,
    );
    assert.ok(KINDS.has(section.kind), `kind inconnu ${section.kind}`);
    assert.ok(!('title' in s), 'aucun titre de section côté serveur');
    assert.ok(section.items.length >= 5 && section.items.length <= 20);
    if (section.kind === 'type')
      assert.strictEqual(section.id, `type:${section.params.type}`);
    if (section.kind === 'genre')
      assert.strictEqual(section.id, `genre:${section.params.genre}`);
    if (section.kind === 'year') {
      assert.strictEqual(
        typeof section.params.year,
        'number',
        'params.year est un nombre',
      );
      assert.strictEqual(section.id, `year:${section.params.year}`);
    }
    if (!['type', 'genre', 'year'].includes(section.kind)) {
      assert.deepStrictEqual(
        section.params,
        {},
        `params vides pour ${section.id}`,
      );
      assert.strictEqual(section.id, section.kind);
    }
    const orderIndex = expectedOrder.findIndex((p) => section.id.startsWith(p));
    assert.ok(
      orderIndex >= previousIndex,
      `ordre serveur violé sur ${section.id}`,
    );
    previousIndex = orderIndex;
    for (const item of section.items) {
      assertItem(item as unknown as Record<string, unknown>, section.id);
      assert.ok(
        !seen.has(item.muId),
        `doublon inter-sections : ${item.muId} déjà dans ${seen.get(
          item.muId,
        )}`,
      );
      seen.set(item.muId, section.id);
    }
  }
  ok(
    `sections : ${home.sections.length} sections, ordre serveur, dédup inter-sections, ≥ 5 titres`,
  );

  // Présence des sections nominales — à `limit` bas pour que la fixture
  // (~150 titres) ne soit pas épuisée par la déduplication inter-sections.
  const small = await controller.getSections({ limit: 5 });
  const ids = small.sections.map((s) => s.id);
  for (const id of [
    'latest',
    'popular',
    'top_rated',
    'type:Manhwa',
    'type:Manhua',
    'type:Manga',
    'genre:Action',
    'community',
    'hidden_gems',
  ]) {
    assert.ok(ids.includes(id), `section attendue absente : ${id}`);
  }
  assert.ok(
    ids.some((id) => id.startsWith('year:')),
    'au moins une section year:<Y>',
  );
  ok(
    'sections : latest, popular, top_rated, type:*, genre:Action, year:*, community, hidden_gems présentes (limit=5)',
  );

  // ── GET /mangas/home/sections/:id?page=1&limit=40 ──────────────────────
  const page = await controller.getSection('type:Manhwa', {
    page: 1,
    limit: 40,
  });
  assert.deepStrictEqual(
    Object.keys(page as unknown as Record<string, unknown>).sort(),
    ['id', 'items', 'kind', 'limit', 'page', 'params', 'total'],
  );
  assert.deepStrictEqual(
    {
      id: page.id,
      kind: page.kind,
      params: page.params,
      page: page.page,
      limit: page.limit,
    },
    {
      id: 'type:Manhwa',
      kind: 'type',
      params: { type: 'Manhwa' },
      page: 1,
      limit: 40,
    },
  );
  assert.strictEqual(typeof page.total, 'number');
  assert.ok(page.items.length <= 40 && page.items.length <= page.total);
  for (const item of page.items)
    assertItem(item as unknown as Record<string, unknown>, 'type:Manhwa');
  ok(
    'section : enveloppe { id, kind, params, page, limit, total, items } et pagination',
  );

  const page2 = await controller.getSection('popular', { page: 2, limit: 5 });
  const page1 = await controller.getSection('popular', { page: 1, limit: 5 });
  assert.strictEqual(page2.page, 2);
  const overlap = page1.items.filter((a) =>
    page2.items.some((b) => b.muId === a.muId),
  );
  assert.strictEqual(overlap.length, 0, 'pages disjointes');
  assert.strictEqual(
    page1.total,
    page2.total,
    'total constant entre les pages',
  );
  ok('section : pages disjointes, total constant');

  const year = await controller.getSection('year:2016', {});
  assert.deepStrictEqual(year.params, { year: 2016 });
  assert.strictEqual(year.page, 1);
  assert.strictEqual(year.limit, 40);
  ok('section : year:<Y> → params.year numérique, défauts page=1 limit=40');

  await assert.rejects(
    controller.getSection('unknown', { page: 1, limit: 20 }),
    (err: { status?: number }) => err.status === 404,
    'id inconnu → 404',
  );
  await assert.rejects(
    controller.getSection('genre:Adult', {}),
    (err: { status?: number }) => err.status === 404,
    'genre NSFW → 404',
  );
  ok('section : 404 sur id inconnu / genre exclu');

  // ── Extrait pour relecture ─────────────────────────────────────────────
  const sample = {
    generatedAt: home.generatedAt,
    sections: home.sections.slice(0, 2).map((s) => ({
      ...s,
      items: s.items.slice(0, 1),
    })),
  };
  process.stdout.write(
    `\nExtrait GET /mangas/home/sections?limit=20 :\n${JSON.stringify(
      sample,
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`\nContrat accueil : ${checks} vérifications OK\n`);
}

main().catch((err) => {
  process.stderr.write(
    `\nContrat accueil : ÉCHEC — ${(err as Error).message}\n`,
  );
  process.exit(1);
});
