import {
  isKnownMangaType,
  MANGA_TYPES,
  normalizeMangaType,
  TYPE_BACKFILL_DEFAULT_TYPES,
} from './manga-type';

describe('normalizeMangaType', () => {
  it('conserve les valeurs canoniques MU telles quelles', () => {
    for (const type of MANGA_TYPES) {
      expect(normalizeMangaType(type)).toBe(type);
    }
  });

  it('ramène une casse ou des espaces divergents à la forme canonique', () => {
    expect(normalizeMangaType('manhwa')).toBe('Manhwa');
    expect(normalizeMangaType('  MANHUA ')).toBe('Manhua');
    expect(normalizeMangaType('drama cd')).toBe('Drama CD');
  });

  it('retourne null (inconnu) pour une valeur absente ou non exploitable', () => {
    expect(normalizeMangaType(null)).toBeNull();
    expect(normalizeMangaType(undefined)).toBeNull();
    expect(normalizeMangaType('')).toBeNull();
    expect(normalizeMangaType('   ')).toBeNull();
    expect(normalizeMangaType(42)).toBeNull();
    expect(normalizeMangaType({ type: 'Manhwa' })).toBeNull();
  });

  it('conserve (trimée) une valeur inconnue plausible plutôt que de la perdre', () => {
    expect(normalizeMangaType(' Webtoon ')).toBe('Webtoon');
  });

  it('refuse une valeur trop longue pour la colonne varchar(32)', () => {
    expect(normalizeMangaType('x'.repeat(33))).toBeNull();
    expect(normalizeMangaType('x'.repeat(32))).toBe('x'.repeat(32));
  });
});

describe('isKnownMangaType / TYPE_BACKFILL_DEFAULT_TYPES', () => {
  it('reconnaît les types canoniques uniquement', () => {
    expect(isKnownMangaType('Manhwa')).toBe(true);
    expect(isKnownMangaType('manhwa')).toBe(false);
    expect(isKnownMangaType('Webtoon')).toBe(false);
  });

  it('cible manhwa et manhua par défaut pour le rattrapage nocturne', () => {
    expect(TYPE_BACKFILL_DEFAULT_TYPES).toEqual(['Manhwa', 'Manhua']);
  });
});
