import {
  buildHomeSectionDefs,
  HOME_ALLOWED_GENRES,
  HOME_GENRES,
  HOME_TYPES,
  isoWeek,
  parseHomeSectionId,
  retroYear,
} from './home-section.catalog';

/** Samedi 2026-09-05 — semaine ISO 36. */
const NOW = new Date('2026-09-05T10:00:00Z');

describe('buildHomeSectionDefs — ordre et identifiants décidés côté serveur', () => {
  it('produit les sections du contrat, dans l’ordre d’affichage et de déduplication', () => {
    const defs = buildHomeSectionDefs(NOW);

    expect(defs.map((d) => d.id)).toEqual([
      'latest',
      'popular',
      'community',
      'top_rated',
      'type:Manhwa',
      'type:Manhua',
      'type:Manga',
      'genre:Action',
      'genre:Fantasy',
      'genre:Romance',
      'genre:Comedy',
      'genre:Drama',
      'genre:Adventure',
      'year:2026',
      'year:2025',
      `year:${retroYear(NOW)}`,
      'hidden_gems',
    ]);
  });

  it('porte des params conformes au contrat : {} / {type} / {genre} / {year: number}', () => {
    const byId = new Map(buildHomeSectionDefs(NOW).map((d) => [d.id, d]));

    expect(byId.get('latest')).toEqual({
      id: 'latest',
      kind: 'latest',
      params: {},
    });
    expect(byId.get('type:Manhwa')).toEqual({
      id: 'type:Manhwa',
      kind: 'type',
      params: { type: 'Manhwa' },
    });
    expect(byId.get('genre:Action')).toEqual({
      id: 'genre:Action',
      kind: 'genre',
      params: { genre: 'Action' },
    });
    expect(byId.get('year:2026')).toEqual({
      id: 'year:2026',
      kind: 'year',
      params: { year: 2026 },
    });
    expect(HOME_TYPES).toEqual(['Manhwa', 'Manhua', 'Manga']);
    expect(HOME_GENRES).toHaveLength(6);
  });
});

describe('retroYear — année rétro tournante', () => {
  it('calcule la semaine ISO (2026-09-05 = semaine 36, 2026-01-01 = semaine 1)', () => {
    expect(isoWeek(NOW)).toBe(36);
    expect(isoWeek(new Date('2026-01-01T12:00:00Z'))).toBe(1);
  });

  it('reste entre 10 et 15 ans en arrière et est stable sur la semaine', () => {
    const year = retroYear(NOW);
    expect(year).toBeGreaterThanOrEqual(2011);
    expect(year).toBeLessThanOrEqual(2016);
    // Lundi et dimanche de la même semaine ISO (heure serveur) → même
    // année rétro. Midi UTC pour rester dans le même jour sur tous les
    // fuseaux d'Europe.
    expect(retroYear(new Date('2026-08-31T12:00:00Z'))).toBe(year);
    expect(retroYear(new Date('2026-09-06T12:00:00Z'))).toBe(year);
    // Semaine suivante → peut changer, toujours dans la fenêtre.
    const next = retroYear(new Date('2026-09-08T12:00:00Z'));
    expect(next).toBeGreaterThanOrEqual(2011);
    expect(next).toBeLessThanOrEqual(2016);
  });
});

describe('parseHomeSectionId — validation des ids de détail', () => {
  it('accepte les sections fixes', () => {
    for (const id of [
      'latest',
      'popular',
      'top_rated',
      'community',
      'hidden_gems',
    ]) {
      expect(parseHomeSectionId(id, NOW)).toEqual({ id, kind: id, params: {} });
    }
  });

  it('accepte tout type MU connu et le normalise', () => {
    expect(parseHomeSectionId('type:Manhwa', NOW)).toEqual({
      id: 'type:Manhwa',
      kind: 'type',
      params: { type: 'Manhwa' },
    });
    expect(parseHomeSectionId('type:manhua', NOW)?.params).toEqual({
      type: 'Manhua',
    });
    // Un type hors accueil mais connu de MU reste une page valide.
    expect(parseHomeSectionId('type:Novel', NOW)?.kind).toBe('type');
    expect(parseHomeSectionId('type:Webtoon', NOW)).toBeNull();
  });

  it('accepte les genres non exclus (insensible à la casse) et refuse les autres', () => {
    expect(parseHomeSectionId('genre:action', NOW)?.params).toEqual({
      genre: 'Action',
    });
    expect(parseHomeSectionId('genre:Slice of Life', NOW)?.id).toBe(
      'genre:Slice of Life',
    );
    expect(HOME_ALLOWED_GENRES).not.toContain('Adult');
    expect(HOME_ALLOWED_GENRES).not.toContain('Mature');
    expect(parseHomeSectionId('genre:Adult', NOW)).toBeNull();
    expect(parseHomeSectionId('genre:Mature', NOW)).toBeNull();
    expect(parseHomeSectionId('genre:Inconnu', NOW)).toBeNull();
  });

  it('accepte une année entre le plancher et l’année courante', () => {
    expect(parseHomeSectionId('year:2014', NOW)).toEqual({
      id: 'year:2014',
      kind: 'year',
      params: { year: 2014 },
    });
    expect(parseHomeSectionId('year:1930', NOW)?.params).toEqual({
      year: 1930,
    });
    expect(parseHomeSectionId('year:1929', NOW)).toBeNull();
    expect(parseHomeSectionId('year:2027', NOW)).toBeNull();
    expect(parseHomeSectionId('year:abcd', NOW)).toBeNull();
    expect(parseHomeSectionId('year:', NOW)).toBeNull();
  });

  it('refuse tout le reste (404 côté controller)', () => {
    expect(parseHomeSectionId('', NOW)).toBeNull();
    expect(parseHomeSectionId('unknown', NOW)).toBeNull();
    expect(parseHomeSectionId(':Manhwa', NOW)).toBeNull();
    expect(parseHomeSectionId('author:Oda', NOW)).toBeNull();
  });
});
