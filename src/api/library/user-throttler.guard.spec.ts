import { UserThrottlerGuard } from './user-throttler.guard';

/** Accès typé au membre protégé `getTracker` sans recourir à `any`. */
type TrackerAccess = {
  getTracker(req: Record<string, unknown>): Promise<string>;
};

describe('UserThrottlerGuard', () => {
  let guard: UserThrottlerGuard;

  beforeEach(() => {
    // getTracker n'utilise ni les options ni le storage : instanciation
    // directe avec des dépendances factices.
    guard = new UserThrottlerGuard([], {} as never, {} as never);
  });

  it("tracke par userId quand req.user est présent (bucket par utilisateur, pas l'IP du proxy)", async () => {
    const tracker = await (guard as unknown as TrackerAccess).getTracker({
      user: { id: 42 },
      ip: '10.0.0.1',
    });

    expect(tracker).toBe('user-42');
  });

  it("retombe sur l'IP quand aucun user n'est authentifié (cas défensif)", async () => {
    const tracker = await (guard as unknown as TrackerAccess).getTracker({
      ip: '10.0.0.1',
    });

    expect(tracker).toBe('10.0.0.1');
  });
});
