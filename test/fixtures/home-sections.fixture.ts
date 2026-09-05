import { Manga } from '../../src/api/mangas/manga.entity';
import { NSFW_GENRES } from '../../src/api/mangas/constants';
import { HomeSectionDef } from '../../src/api/mangas/home/home-section.catalog';
import { HomeSectionQueryBuilder } from '../../src/api/mangas/home/home-sections.query';

/**
 * Fixtures de l'accueil « façon Netflix », partagées par les tests Jest
 * (`home-sections.service.spec.ts`, `home-sections.controller.spec.ts`) et
 * par le script de vérification du contrat (`test/home-sections.contract.ts`).
 *
 * `FakeHomeSectionQueryBuilder` est une implémentation EN MÉMOIRE des règles
 * de section documentées dans `HomeSectionQueryBuilder` : mêmes filtres,
 * mêmes tris. Elle ne prouve pas le SQL (pas de base locale disponible),
 * mais elle prouve l'assemblage : ordre des sections, déduplication,
 * omission sous 5 titres, pagination, forme exacte du contrat.
 */

export interface FixtureOptions {
  /** Année courante simulée (défaut 2026). */
  currentYear?: number;
}

/** Nombre d'utilisateurs suivant chaque titre (par `mu_id`). */
export type LibraryCounts = Map<string, number>;

export interface HomeFixture {
  mangas: Manga[];
  libraries: LibraryCounts;
  /** Liens de recommandation MU entrants par `mu_id` (visibilité). */
  recoLinks: Map<string, number>;
}

function manga(
  id: number,
  overrides: Partial<Manga> & { genres?: string[] },
): Manga {
  const m = new Manga();
  m.id = id;
  m.mu_id = String(id);
  m.title = `Title ${id}`;
  m.small_cover_url = `https://cdn/${id}-s.jpg`;
  m.medium_cover_url = `https://cdn/${id}.jpg`;
  m.total_chapters = 10;
  m.rating = 7.0;
  m.year = 2020;
  m.completed = false;
  m.genres = ['Drama'];
  m.type = 'Manga';
  m.created_at = new Date('2026-09-01T00:00:00Z');
  m.updated_at = m.created_at;
  return Object.assign(m, overrides);
}

/** Ids des trois titres « à exclure » (NSFW, sans cover, sans genres). */
export const EXCLUDED_FIXTURE_IDS = [9001, 9002, 9003];

/**
 * Catalogue de ~290 titres : 80 manhwa, 30 manhua, 120 mangas, 20 sans type,
 * 40 « pépites » (Mystery, très bien notées, suivies par personne), 3 titres
 * NSFW/sans cover/sans genres (à exclure), années courante, précédente,
 * 2016-2019, 2005, 1995 ; bibliothèques de 4 utilisateurs sur 12 titres.
 */
export function buildHomeFixture(options: FixtureOptions = {}): HomeFixture {
  const cy = options.currentYear ?? 2026;
  const mangas: Manga[] = [];
  let id = 1000;

  // 80 manhwa : Action/Fantasy ou Romance/Drama, notes 6.0 → 8.9.
  for (let i = 0; i < 80; i++) {
    mangas.push(
      manga(id++, {
        type: 'Manhwa',
        genres: i % 2 === 0 ? ['Action', 'Fantasy'] : ['Romance', 'Drama'],
        rating: 6 + (i % 30) * 0.1,
        year: [cy, cy - 1, 2019, 2016][i % 4],
        total_chapters: 50 + i,
      }),
    );
  }
  // 30 manhua : Comedy/Adventure, notes 6.5 → 8.75.
  for (let i = 0; i < 30; i++) {
    mangas.push(
      manga(id++, {
        type: 'Manhua',
        genres: ['Comedy', 'Adventure'],
        rating: 6.5 + (i % 16) * 0.15,
        year: i % 2 === 0 ? cy - 1 : 2018,
      }),
    );
  }
  // 120 mangas : toutes années, notes 6.0 → 8.9, genres variés.
  const genres = [
    ['Action'],
    ['Fantasy', 'Adventure'],
    ['Romance'],
    ['Comedy'],
    ['Drama'],
  ];
  for (let i = 0; i < 120; i++) {
    mangas.push(
      manga(id++, {
        type: 'Manga',
        genres: genres[i % genres.length],
        rating: 6 + (i % 30) * 0.1,
        year: [cy, cy - 1, 2016, 2005, 1995][i % 5],
      }),
    );
  }
  // 20 titres sans type (pas encore rattrapés), bien notés.
  for (let i = 0; i < 20; i++) {
    mangas.push(
      manga(id++, { type: null, genres: ['Action'], rating: 8.2, year: cy }),
    );
  }
  // 40 pépites : Mystery (hors sections genre), 8.5 → 8.9, 2012-2019,
  // suivies par personne → matière pour `hidden_gems`.
  for (let i = 0; i < 40; i++) {
    mangas.push(
      manga(id++, {
        type: 'Manga',
        genres: ['Mystery'],
        rating: 8.5 + (i % 5) * 0.1,
        year: 2012 + (i % 8),
      }),
    );
  }
  // Exclus : NSFW, sans cover, sans genres.
  mangas.push(
    manga(EXCLUDED_FIXTURE_IDS[0], {
      genres: ['Adult', 'Romance'],
      rating: 9.5,
    }),
  );
  mangas.push(
    manga(EXCLUDED_FIXTURE_IDS[1], { medium_cover_url: null, rating: 9.4 }),
  );
  mangas.push(
    manga(EXCLUDED_FIXTURE_IDS[2], { genres: undefined, rating: 9.3 }),
  );

  // Bibliothèques : 12 titres suivis (manhwa), dont 3 par ≥ 2 utilisateurs.
  const libraries: LibraryCounts = new Map();
  const followed = mangas.slice(0, 12);
  followed.forEach((m, i) => libraries.set(m.mu_id, i < 3 ? 3 : 1));

  // Visibilité MU : les 10 meilleurs manhwa sont très recommandés (≥ 5
  // liens) → exclus des pépites ; tout le reste est peu visible.
  const recoLinks = new Map<string, number>();
  [...mangas]
    .filter((m) => m.type === 'Manhwa')
    .sort((a, b) => Number(b.rating) - Number(a.rating))
    .slice(0, 10)
    .forEach((m) => recoLinks.set(m.mu_id, 12));

  return { mangas, libraries, recoLinks };
}

/** QueryBuilder minimal (le sous-ensemble consommé par `HomeSectionsService`). */
export class FakeQuery {
  private offsetValue = 0;
  private limitValue: number | null = null;

  constructor(private readonly rows: Manga[]) {}

  limit(n: number): this {
    this.limitValue = n;
    return this;
  }

  offset(n: number): this {
    this.offsetValue = n;
    return this;
  }

  clone(): FakeQuery {
    return new FakeQuery(this.rows);
  }

  async getMany(): Promise<Manga[]> {
    const end =
      this.limitValue === null ? undefined : this.offsetValue + this.limitValue;
    return this.rows.slice(this.offsetValue, end);
  }

  async getCount(): Promise<number> {
    return this.rows.length;
  }
}

const NULLS_LAST = (v: number | null | undefined) =>
  v === null || v === undefined ? -Infinity : Number(v);

type Comparator = (a: Manga, b: Manga) => number;

const byRatingDesc: Comparator = (a, b) =>
  NULLS_LAST(b.rating) - NULLS_LAST(a.rating);
const byYearDesc: Comparator = (a, b) =>
  NULLS_LAST(b.year) - NULLS_LAST(a.year);
const byIdAsc: Comparator = (a, b) => a.id - b.id;
const byIdDesc: Comparator = (a, b) => b.id - a.id;

function chain(...comparators: Comparator[]): Comparator {
  return (a, b) => {
    for (const cmp of comparators) {
      const r = cmp(a, b);
      if (r !== 0) return r;
    }
    return 0;
  };
}

/**
 * Implémentation en mémoire des règles de `HomeSectionQueryBuilder`. Peut
 * être configurée pour échouer sur certaines sections (test de résilience).
 */
export class FakeHomeSectionQueryBuilder {
  readonly builtIds: string[] = [];
  readonly failingIds = new Set<string>();

  constructor(private readonly fixture: HomeFixture) {}

  build(def: HomeSectionDef, now: Date): FakeQuery {
    this.builtIds.push(def.id);
    if (this.failingIds.has(def.id)) {
      const failing = {
        offset: () => failing,
        limit: () => failing,
        getMany: () => Promise.reject(new Error(`SQL failure ${def.id}`)),
      };
      return failing as unknown as FakeQuery;
    }
    return new FakeQuery(this.select(def, now));
  }

  private libs(m: Manga): number {
    return this.fixture.libraries.get(m.mu_id) ?? 0;
  }

  private links(m: Manga): number {
    return this.fixture.recoLinks.get(m.mu_id) ?? 0;
  }

  private select(def: HomeSectionDef, now: Date): Manga[] {
    const cy = now.getFullYear();
    const base = this.fixture.mangas.filter(
      (m) =>
        m.medium_cover_url &&
        Array.isArray(m.genres) &&
        !m.genres.some((g) => NSFW_GENRES.includes(g)),
    );
    const Q = HomeSectionQueryBuilder;
    switch (def.kind) {
      case 'latest':
        return base
          .filter((m) => (m.year ?? 0) >= cy - 1)
          .sort(
            chain(
              byYearDesc,
              byRatingDesc,
              (a, b) => b.total_chapters - a.total_chapters,
              byIdDesc,
            ),
          );
      case 'popular':
        return base
          .filter((m) => m.rating !== null)
          .sort(chain(byRatingDesc, byIdAsc));
      case 'top_rated':
        return base
          .filter(
            (m) =>
              Number(m.rating) >= Q.TOP_RATING_FLOOR &&
              (m.year ?? 0) >= cy - Q.TOP_RATED_YEAR_SPAN,
          )
          .sort(chain(byRatingDesc, byYearDesc, byIdAsc));
      case 'type':
        return base
          .filter((m) => m.type === def.params.type)
          .sort(chain(byRatingDesc, byYearDesc, byIdAsc));
      case 'genre':
        return base
          .filter(
            (m) =>
              (m.genres ?? []).includes(String(def.params.genre)) &&
              Number(m.rating) >= Q.GENRE_RATING_FLOOR,
          )
          .sort(chain(byRatingDesc, byIdAsc));
      case 'year':
        return base
          .filter((m) => m.year === def.params.year)
          .sort(chain(byRatingDesc, byIdAsc));
      case 'community':
        return base
          .filter((m) => this.libs(m) > 0)
          .sort(
            chain((a, b) => this.libs(b) - this.libs(a), byRatingDesc, byIdAsc),
          );
      case 'hidden_gems':
        return base
          .filter(
            (m) =>
              Number(m.rating) >= Q.TOP_RATING_FLOOR &&
              this.libs(m) <= Q.HIDDEN_GEMS_MAX_LIBRARIES &&
              this.links(m) < Q.HIDDEN_GEMS_VISIBILITY_THRESHOLD,
          )
          .sort(chain(byRatingDesc, byYearDesc, byIdAsc));
    }
  }
}
