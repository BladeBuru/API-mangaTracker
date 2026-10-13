import { Injectable } from '@nestjs/common';
import {
  UserScopedThrottlerConfig,
  UserScopedThrottlerGuard,
} from '@/api/library/user-scoped-throttler.guard';

/**
 * Anti-spam de `POST /friends/request` : 5 demandes d'amitié par minute
 * et par utilisateur.
 *
 * Quota PAR UTILISATEUR (cf. `UserScopedThrottlerGuard`) : l'ancien
 * `@Throttle()` tracké par IP était, derrière le reverse proxy, un budget
 * partagé par TOUS les utilisateurs. À placer APRÈS `JwtAuthGuard`.
 */
@Injectable()
export class FriendRequestThrottlerGuard extends UserScopedThrottlerGuard {
  /** Fenêtre de comptage (ms). */
  static readonly WINDOW_MS = 60_000;

  /** Quota par fenêtre et par utilisateur. */
  static readonly LIMIT = 5;

  /** Nom du throttler dédié — distinct du `default` global. */
  static readonly THROTTLER_NAME = 'friend-request';

  protected throttlerConfig(): UserScopedThrottlerConfig {
    return {
      name: FriendRequestThrottlerGuard.THROTTLER_NAME,
      ttl: FriendRequestThrottlerGuard.WINDOW_MS,
      limit: FriendRequestThrottlerGuard.LIMIT,
    };
  }
}
