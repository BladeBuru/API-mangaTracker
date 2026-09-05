import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { ReadingStatus } from '@/api/library/reading-status.enum';
import {
  applyTypeBucket,
  computeTypeProfile,
  DISCOVERY_SHARE,
  emptyTypeProfile,
  interleaveByTypeMix,
  isEmptyTypeProfile,
  libraryWeight,
  planTypeQueryBuckets,
  TypeProfile,
  UNKNOWN_TYPE_KEY,
} from './type-profile';

function um(
  type: string | null,
  overrides: Partial<UserManga> = {},
): UserManga {
  const manga = new Manga();
  manga.mu_id = String(Math.floor(Math.random() * 1e9));
  manga.title = `Manga ${type ?? '?'}`;
  manga.type = type;
  const entry = new UserManga();
  entry.manga = manga;
  entry.user_rating = 0;
  entry.readingStatus = ReadingStatus.Reading;
  entry.adding_date = new Date();
  return Object.assign(entry, overrides);
}

/** Bibliothèque fidèle à la prod (U1, ids masqués) : 50 Manhwa, 10 Manhua, 6 Manga, 2 OEL. */
function prodLikeLibrary(): UserManga[] {
  return [
    ...Array.from({ length: 50 }, () => um('Manhwa')),
    ...Array.from({ length: 10 }, () => um('Manhua')),
    ...Array.from({ length: 6 }, () => um('Manga')),
    ...Array.from({ length: 2 }, () => um('OEL')),
  ];
}

interface Item {
  id: number;
  type: string | null;
}

/** `n` items d'un type donné, ids croissants = score décroissant. */
function items(type: string | null, n: number, from = 0): Item[] {
  return Array.from({ length: n }, (_, i) => ({ id: from + i, type }));
}

function countBy(list: Item[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of list) {
    const key = item.type ?? UNKNOWN_TYPE_KEY;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe('computeTypeProfile', () => {
  it('reflète la répartition réelle des bibliothèques prod (73 % manhwa) et marque la préférence', () => {
    const profile = computeTypeProfile(prodLikeLibrary());

    expect(profile.shares.get('Manhwa')).toBeCloseTo(50 / 68, 2);
    expect(profile.shares.get('Manhua')).toBeCloseTo(10 / 68, 2);
    expect(profile.shares.get('Manga')).toBeCloseTo(6 / 68, 2);
    expect(profile.dominant).toEqual({
      type: 'Manhwa',
      share: expect.closeTo(0.735, 2),
    });
    expect(profile.marked).toBe(true);
    expect(profile.knownCount).toBe(68);
    expect(profile.unknownShare).toBe(0);
  });

  it('pondère par statut de lecture et note perso, sans décroissance temporelle', () => {
    const old = new Date('2015-01-01');
    const profile = computeTypeProfile([
      // Manhwa terminé et noté 10/10, ajouté il y a 11 ans → poids 1.5 × 2 = 3
      um('Manhwa', {
        readingStatus: ReadingStatus.Completed,
        user_rating: 10,
        adding_date: old,
      }),
      // Manga « à lire plus tard », non noté → poids 0.8
      um('Manga', { readingStatus: ReadingStatus.ReadLater }),
    ]);

    expect(
      libraryWeight(
        um('Manhwa', { readingStatus: 'completed', user_rating: 10 }),
      ),
    ).toBe(3);
    expect(profile.shares.get('Manhwa')).toBeCloseTo(3 / 3.8, 3);
    expect(profile.shares.get('Manga')).toBeCloseTo(0.8 / 3.8, 3);
  });

  it('profil vide (comportement historique) sans bibliothèque ou sans type connu', () => {
    expect(isEmptyTypeProfile(computeTypeProfile([]))).toBe(true);
    const allUnknown = computeTypeProfile([um(null), um(null)]);
    expect(isEmptyTypeProfile(allUnknown)).toBe(true);
    expect(allUnknown.unknownShare).toBe(1);
  });

  it('ignore un profil dont moins de la moitié des titres sont typés (transition avant rattrapage)', () => {
    const profile = computeTypeProfile([um('Manhwa'), um(null), um(null)]);
    expect(isEmptyTypeProfile(profile)).toBe(true);
  });

  it('préférence non marquée sous 60 % de part dominante', () => {
    const profile = computeTypeProfile([um('Manhwa'), um('Manga')]);
    expect(profile.marked).toBe(false);
    expect(profile.dominant?.share).toBe(0.5);
  });
});

describe('interleaveByTypeMix — sélection au prorata du profil', () => {
  const eighty: TypeProfile = {
    shares: new Map([
      ['Manhwa', 0.8],
      ['Manga', 0.2],
    ]),
    dominant: { type: 'Manhwa', share: 0.8 },
    marked: true,
    unknownShare: 0,
    knownCount: 10,
  };

  it('un lecteur à 80 % manhwa reçoit ≈ 80 % de manhwa dès les 20 premières cartes', () => {
    // Pool trié par score : 50 mangas D'ABORD (meilleurs scores), puis 50 manhwa.
    const pool = [...items('Manga', 50), ...items('Manhwa', 50, 100)];

    const mixed = interleaveByTypeMix(pool, (i) => i.type, eighty);

    expect(countBy(mixed.slice(0, 20))).toEqual({ Manhwa: 16, Manga: 4 });
    expect(countBy(mixed.slice(0, 10))).toEqual({ Manhwa: 8, Manga: 2 });
    // La première carte est un manhwa (part dominante), pas le manga au
    // meilleur score global.
    expect(mixed[0].type).toBe('Manhwa');
    // Rien n'est perdu ni dupliqué.
    expect(mixed).toHaveLength(100);
    expect(new Set(mixed.map((i) => i.id)).size).toBe(100);
  });

  it("conserve l'ordre par score à l'intérieur de chaque type", () => {
    const pool = [...items('Manga', 5), ...items('Manhwa', 5, 100)];
    const mixed = interleaveByTypeMix(pool, (i) => i.type, eighty);

    const manhwaIds = mixed.filter((i) => i.type === 'Manhwa').map((i) => i.id);
    const mangaIds = mixed.filter((i) => i.type === 'Manga').map((i) => i.id);
    expect(manhwaIds).toEqual([100, 101, 102, 103, 104]);
    expect(mangaIds).toEqual([0, 1, 2, 3, 4]);
  });

  it('jamais zéro : un seul manhwa disponible sort en tête, le reste complète au prorata', () => {
    const pool = [...items('Manga', 30), ...items('Manhwa', 1, 100)];
    const mixed = interleaveByTypeMix(pool, (i) => i.type, eighty);

    expect(mixed[0]).toEqual({ id: 100, type: 'Manhwa' });
    expect(mixed).toHaveLength(31);
  });

  it('type inconnu : autorisé mais pénalisé de moitié quand la préférence est marquée', () => {
    // 50 % du pool sans type → u = 0.5 × 0.5 = 0.25 (marqué).
    const pool = [...items(null, 50), ...items('Manhwa', 50, 100)];
    const mixed = interleaveByTypeMix(pool, (i) => i.type, eighty);

    const head = countBy(mixed.slice(0, 20));
    expect(head[UNKNOWN_TYPE_KEY]).toBe(5);
    expect(head.Manhwa).toBe(15);
  });

  it('type inconnu : part réelle conservée quand la préférence n’est pas marquée', () => {
    const balanced: TypeProfile = { ...eighty, marked: false };
    const pool = [...items(null, 50), ...items('Manhwa', 50, 100)];
    const mixed = interleaveByTypeMix(pool, (i) => i.type, balanced);

    expect(countBy(mixed.slice(0, 20))[UNKNOWN_TYPE_KEY]).toBe(10);
  });

  it('découverte : un type hors profil présent dans le pool garde une petite part', () => {
    const pool = [...items('Manhua', 20), ...items('Manhwa', 60, 100)];
    const onlyManhwa: TypeProfile = {
      ...eighty,
      shares: new Map([['Manhwa', 1]]),
      dominant: { type: 'Manhwa', share: 1 },
    };
    const mixed = interleaveByTypeMix(pool, (i) => i.type, onlyManhwa);

    const head = countBy(mixed.slice(0, 40));
    expect(head.Manhua).toBe(Math.round(40 * DISCOVERY_SHARE));
    expect(head.Manhwa).toBe(40 - head.Manhua);
  });

  it('sans profil, la liste est rendue telle quelle (comportement historique)', () => {
    const pool = [...items('Manga', 3), ...items('Manhwa', 3, 100)];
    expect(interleaveByTypeMix(pool, (i) => i.type, emptyTypeProfile())).toBe(
      pool,
    );
  });

  it('un bucket épuisé laisse ses slots aux autres (jamais de trou)', () => {
    const pool = [...items('Manhwa', 4, 100), ...items('Manga', 20)];
    const mixed = interleaveByTypeMix(pool, (i) => i.type, eighty);

    expect(mixed).toHaveLength(24);
    expect(countBy(mixed.slice(0, 5)).Manhwa).toBe(4);
    expect(mixed.slice(5).every((i) => i.type === 'Manga')).toBe(true);
  });
});

describe('planTypeQueryBuckets / applyTypeBucket — candidats par type', () => {
  const profile = computeTypeProfile(prodLikeLibrary());

  it('sans profil : une seule requête sans filtre (historique)', () => {
    expect(planTypeQueryBuckets(emptyTypeProfile(), 300)).toEqual([
      { kind: 'all', limit: 300 },
    ]);
  });

  it('avec profil : un bucket par type au prorata (plancher 10), plus inconnus et découverte', () => {
    const buckets = planTypeQueryBuckets(profile, 300);

    const known = buckets.filter((b) => b.kind === 'known');
    expect(known.map((b) => b.type).sort()).toEqual(
      ['Manga', 'Manhua', 'Manhwa', 'OEL'].sort(),
    );
    expect(known.find((b) => b.type === 'Manhwa')?.limit).toBe(
      Math.ceil((50 / 68) * 300),
    );
    // OEL = 2/68 × 300 ≈ 9 → plancher 10.
    expect(known.find((b) => b.type === 'OEL')?.limit).toBe(10);
    // Préférence marquée → 35 % du budget pour les inconnus.
    expect(buckets.find((b) => b.kind === 'unknown')?.limit).toBe(105);
    expect(buckets.find((b) => b.kind === 'other')?.limit).toBe(30);
  });

  it('applique le filtre SQL correspondant à chaque bucket', () => {
    const calls: Array<[string, unknown?]> = [];
    const qb = {
      andWhere: jest.fn((sql: string, params?: unknown) => {
        calls.push([sql, params]);
        return qb;
      }),
    } as unknown as Parameters<typeof applyTypeBucket>[0];

    applyTypeBucket(qb, { kind: 'known', type: 'Manhwa', limit: 1 }, profile);
    applyTypeBucket(qb, { kind: 'unknown', limit: 1 }, profile);
    applyTypeBucket(qb, { kind: 'other', limit: 1 }, profile);
    applyTypeBucket(qb, { kind: 'all', limit: 1 }, profile);

    expect(calls[0]).toEqual([
      'm.type = :bucketType',
      { bucketType: 'Manhwa' },
    ]);
    expect(calls[1]).toEqual(['m.type IS NULL', undefined]);
    expect(calls[2][0]).toBe('m.type IS NOT NULL');
    expect(calls[3][0]).toBe('m.type NOT IN (:...profileTypes)');
    expect(
      (calls[3][1] as { profileTypes: string[] }).profileTypes.sort(),
    ).toEqual(['Manga', 'Manhua', 'Manhwa', 'OEL'].sort());
    // `all` n'ajoute aucune clause.
    expect(calls).toHaveLength(4);
  });
});
