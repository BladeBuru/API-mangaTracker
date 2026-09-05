import { Logger } from '@nestjs/common';
import { MuRateLimitException } from './exceptions/mu-rate-limit.exception';
import {
  buildAssociatedUpdate,
  buildProtectedColumnsUpdate,
  hydrateIncompleteDtosInBackground,
  isIncompleteDto,
  ON_DEMAND_HYDRATION_CAP,
  PROTECTED_NULLABLE_COLUMNS,
} from './manga-completeness.util';

/** Logger silencieux capturant les messages. */
function makeLogger(): Logger & { logs: string[]; warns: string[] } {
  const logs: string[] = [];
  const warns: string[] = [];
  const logger = {
    logs,
    warns,
    log: (m: string) => logs.push(m),
    warn: (m: string) => warns.push(m),
    error: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
  };
  return logger as unknown as Logger & { logs: string[]; warns: string[] };
}

/** Laisse tourner les microtâches du fire-and-forget. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('buildProtectedColumnsUpdate — UPDATE null-safe', () => {
  const fullDetails = {
    year: 2019,
    rating: 8.42,
    smallCoverUrl: 'https://cdn/small.jpg',
    mediumCoverUrl: 'https://cdn/medium.jpg',
  };

  it('écrase normalement quand MU renvoie de vraies valeurs', () => {
    const update = buildProtectedColumnsUpdate(fullDetails, ['Action']);

    // On refuse le null, on ne fige PAS la donnée : une vraie valeur MU doit
    // continuer d'écraser l'ancienne.
    expect(update).toEqual({
      year: 2019,
      rating: 8.42,
      small_cover_url: 'https://cdn/small.jpg',
      medium_cover_url: 'https://cdn/medium.jpg',
      genres: ['Action'],
    });
  });

  it('omet les colonnes que MU renvoie à null (valeur existante préservée)', () => {
    // Cas prod : titre peu voté → `bayesian_rating: null`, pas d'année.
    const update = buildProtectedColumnsUpdate(
      {
        year: null,
        rating: null,
        smallCoverUrl: null,
        mediumCoverUrl: null,
      },
      null,
    );

    // Aucune colonne dans le SET → l'UPDATE ne touche pas la ligne existante.
    expect(update).toEqual({});
    expect(Object.keys(update)).toHaveLength(0);
  });

  it('préserve la valeur en base colonne par colonne (rating null, année réelle)', () => {
    const update = buildProtectedColumnsUpdate({
      year: 2005,
      rating: null,
      smallCoverUrl: 'https://cdn/s.jpg',
      mediumCoverUrl: null,
    });

    expect(update).toHaveProperty('year', 2005);
    expect(update).toHaveProperty('small_cover_url', 'https://cdn/s.jpg');
    // Les deux colonnes absentes du payload MU ne sont pas dans le SET.
    expect(update).not.toHaveProperty('rating');
    expect(update).not.toHaveProperty('medium_cover_url');
  });

  it('traite undefined et la chaîne vide comme « absent »', () => {
    const update = buildProtectedColumnsUpdate({
      year: undefined,
      rating: undefined,
      smallCoverUrl: '',
      mediumCoverUrl: '',
    });

    expect(update).toEqual({});
  });

  it("ne touche pas `genres` quand l'appelant ne le fournit pas", () => {
    const update = buildProtectedColumnsUpdate(fullDetails);

    expect(update).not.toHaveProperty('genres');
  });

  it('écrit `genres: []` (MU a répondu « aucun genre ») mais jamais null', () => {
    expect(buildProtectedColumnsUpdate(fullDetails, [])).toHaveProperty(
      'genres',
      [],
    );
    expect(buildProtectedColumnsUpdate(fullDetails, null)).not.toHaveProperty(
      'genres',
    );
  });

  it('conserve un rating de 0 (valeur réelle, pas une absence)', () => {
    const update = buildProtectedColumnsUpdate({ rating: 0 });

    expect(update).toHaveProperty('rating', 0);
  });

  it('couvre exactement les colonnes nullable protégées', () => {
    expect([...PROTECTED_NULLABLE_COLUMNS]).toEqual([
      'year',
      'rating',
      'small_cover_url',
      'medium_cover_url',
      'genres',
      'type',
    ]);
  });
});

describe('hydrateIncompleteDtosInBackground — hydratation à la demande', () => {
  const dto = (muId: number, year: number, rating: number) => ({
    muId,
    year,
    rating,
  });

  it('ne cible que les DTO incomplets (year == 0 ou rating == 0)', () => {
    expect(isIncompleteDto(dto(1, 0, 8))).toBe(true);
    expect(isIncompleteDto(dto(2, 2019, 0))).toBe(true);
    expect(isIncompleteDto(dto(3, 0, 0))).toBe(true);
    expect(isIncompleteDto(dto(4, 2019, 8))).toBe(false);
  });

  it('déclenche getMangaDetails sur les seuls DTO incomplets', async () => {
    const hydrate = jest.fn().mockResolvedValue({});
    const targets = hydrateIncompleteDtosInBackground(
      [dto(1, 2019, 8.1), dto(2, 0, 7.5), dto(3, 2001, 0)],
      hydrate,
      makeLogger(),
    );

    expect(targets).toEqual([2, 3]);
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(hydrate).toHaveBeenCalledWith(2);
    expect(hydrate).toHaveBeenCalledWith(3);
  });

  it('plafonne strictement à 8 mangas par requête', async () => {
    const hydrate = jest.fn().mockResolvedValue({});
    const dtos = Array.from({ length: 30 }, (_, i) => dto(i + 1, 0, 0));

    const targets = hydrateIncompleteDtosInBackground(
      dtos,
      hydrate,
      makeLogger(),
    );

    expect(ON_DEMAND_HYDRATION_CAP).toBe(8);
    expect(targets).toHaveLength(8);
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(8);
  });

  it('déduplique les mu_id et ignore les identifiants invalides', async () => {
    const hydrate = jest.fn().mockResolvedValue({});

    const targets = hydrateIncompleteDtosInBackground(
      [dto(7, 0, 0), dto(7, 0, 0), dto(0, 0, 0), dto(NaN, 0, 0)],
      hydrate,
      makeLogger(),
    );

    expect(targets).toEqual([7]);
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it('ne fait rien (et ne logge pas) quand tous les DTO sont complets', async () => {
    const hydrate = jest.fn();
    const logger = makeLogger();

    const targets = hydrateIncompleteDtosInBackground(
      [dto(1, 2019, 8.1)],
      hydrate,
      logger,
    );

    expect(targets).toEqual([]);
    await flush();
    expect(hydrate).not.toHaveBeenCalled();
    expect(logger.logs).toHaveLength(0);
  });

  it('est fire-and-forget : rend la main sans attendre MU', async () => {
    // Une hydratation qui ne se résout JAMAIS ne doit pas bloquer l'appelant.
    const hydrate = jest.fn().mockReturnValue(new Promise(() => undefined));

    const targets = hydrateIncompleteDtosInBackground(
      [dto(1, 0, 0)],
      hydrate,
      makeLogger(),
    );

    // Retour immédiat : l'appel MU n'est même pas encore parti (microtâche).
    expect(targets).toEqual([1]);
    expect(hydrate).not.toHaveBeenCalled();

    // Il part bien en tâche de fond, et reste pendant sans gêner personne.
    await flush();
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it('échoue en silence : un rejet MU ne remonte jamais à la requête principale', async () => {
    const hydrate = jest.fn().mockRejectedValue(new Error('MU down'));
    const logger = makeLogger();

    expect(() =>
      hydrateIncompleteDtosInBackground([dto(1, 0, 0)], hydrate, logger),
    ).not.toThrow();

    await flush();
    expect(logger.warns.join(' ')).toContain('MU down');
  });

  it('avale un 429 MuRateLimitException sans le propager', async () => {
    const hydrate = jest.fn().mockRejectedValue(new MuRateLimitException(42));
    const logger = makeLogger();

    expect(() =>
      hydrateIncompleteDtosInBackground([dto(42, 0, 0)], hydrate, logger),
    ).not.toThrow();

    await flush();
    expect(logger.warns.join(' ')).toContain('rate limit MU (429)');
  });

  it('survit à un hydrate qui lève de façon synchrone', async () => {
    const hydrate = jest.fn(() => {
      throw new Error('boom synchrone');
    });
    const logger = makeLogger();

    expect(() =>
      hydrateIncompleteDtosInBackground([dto(1, 0, 0)], hydrate, logger),
    ).not.toThrow();

    await flush();
    expect(logger.warns.join(' ')).toContain('boom synchrone');
  });

  it("continue les autres hydratations quand l'une d'elles échoue", async () => {
    const hydrate = jest
      .fn()
      .mockRejectedValueOnce(new Error('MU down'))
      .mockResolvedValue({});

    hydrateIncompleteDtosInBackground(
      [dto(1, 0, 0), dto(2, 0, 0), dto(3, 0, 0)],
      hydrate,
      makeLogger(),
    );

    await flush();
    expect(hydrate).toHaveBeenCalledTimes(3);
  });
});

/**
 * `associated` (titres alternatifs) n'est renseigné que par `/v1/series/{id}`.
 * `MangaDetailsDto.fromMU` applique `muObject['associated'] ?? []` : une
 * réponse MU sans le champ produit un tableau VIDE, indiscernable d'un « MU
 * n'a rien renvoyé ». L'UPDATE écrivait ce `[]` sans condition — une fiche
 * déjà pourvue pouvait donc PERDRE ses titres alternatifs.
 */
describe('buildAssociatedUpdate', () => {
  it('should write associated when MU actually returned titles', () => {
    const titles = [{ title: 'Kimetsu no Yaiba' }, { title: 'Demon Slayer' }];

    expect(buildAssociatedUpdate(titles)).toEqual({ associated: titles });
  });

  it('should omit the column on an EMPTY array (never erase existing titles)', () => {
    expect(buildAssociatedUpdate([])).toEqual({});
  });

  it('should omit the column on null/undefined', () => {
    expect(buildAssociatedUpdate(null)).toEqual({});
    expect(buildAssociatedUpdate(undefined)).toEqual({});
  });

  it('should omit the column on a non-array payload', () => {
    expect(
      buildAssociatedUpdate('nope' as unknown as { title: string }[]),
    ).toEqual({});
  });
});

describe('buildProtectedColumnsUpdate — type de publication (2026-09-05)', () => {
  it('écrit `type` quand la fiche MU le fournit', () => {
    const update = buildProtectedColumnsUpdate({ year: 2019, type: 'Manhwa' });

    expect(update).toEqual({ year: 2019, type: 'Manhwa' });
  });

  it("omet `type` quand il est absent (un type connu n'est jamais remis à NULL)", () => {
    expect(buildProtectedColumnsUpdate({ year: 2019 })).toEqual({ year: 2019 });
    expect(buildProtectedColumnsUpdate({ year: 2019, type: null })).toEqual({
      year: 2019,
    });
    expect(buildProtectedColumnsUpdate({ year: 2019, type: '' })).toEqual({
      year: 2019,
    });
  });

  it('`type` fait partie des colonnes protégées partagées', () => {
    expect(PROTECTED_NULLABLE_COLUMNS).toContain('type');
  });
});
