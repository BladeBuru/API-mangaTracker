import { MuJobLockService } from './mu-job-lock.service';

describe('MuJobLockService — un seul job MU à la fois', () => {
  let lock: MuJobLockService;

  beforeEach(() => {
    lock = new MuJobLockService();
  });

  it('accorde le verrou au premier demandeur et le refuse aux suivants', () => {
    expect(lock.tryAcquire('catalog')).toBe(true);
    expect(lock.current).toBe('catalog');

    // Un AUTRE job (releases, type-backfill…) est refusé : jamais deux jobs
    // MU en parallèle, c'est tout l'objet du verrou partagé.
    expect(lock.tryAcquire('releases')).toBe(false);
    expect(lock.tryAcquire('type-backfill')).toBe(false);
    // Le même job aussi (anti-réentrance).
    expect(lock.tryAcquire('catalog')).toBe(false);
  });

  it('ne libère le verrou que pour son détenteur', () => {
    lock.tryAcquire('catalog');

    lock.release('releases'); // pas le détenteur → no-op
    expect(lock.current).toBe('catalog');

    lock.release('catalog');
    expect(lock.current).toBeNull();
    expect(lock.tryAcquire('releases')).toBe(true);
  });

  it('release sans détenteur est un no-op sûr', () => {
    expect(() => lock.release('catalog')).not.toThrow();
    expect(lock.current).toBeNull();
  });
});
