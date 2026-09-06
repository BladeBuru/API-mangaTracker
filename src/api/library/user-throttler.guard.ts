import { Injectable } from '@nestjs/common';
import {
  UserScopedThrottlerConfig,
  UserScopedThrottlerGuard,
} from './user-scoped-throttler.guard';

/**
 * Garde de rate-limiting PAR UTILISATEUR pour la route de signalement
 * `report-chapters` : 10 signalements par heure et par utilisateur.
 *
 * Le tracking par `req.user.id` (plutôt que par IP, inexploitable derrière
 * le reverse proxy NPMplus) et le remplacement des throttlers injectés sont
 * portés par `UserScopedThrottlerGuard`.
 */
@Injectable()
export class UserThrottlerGuard extends UserScopedThrottlerGuard {
  /** Fenêtre de 1 h (ms) du garde-fou anti-abus. */
  private static readonly WINDOW_MS = 3_600_000;

  /** Quota : 10 signalements par fenêtre et par utilisateur. */
  private static readonly LIMIT = 10;

  /** Nom du throttler dédié — distinct du `default` global. */
  private static readonly THROTTLER_NAME = 'report-chapters';

  protected throttlerConfig(): UserScopedThrottlerConfig {
    return {
      name: UserThrottlerGuard.THROTTLER_NAME,
      ttl: UserThrottlerGuard.WINDOW_MS,
      limit: UserThrottlerGuard.LIMIT,
    };
  }
}
