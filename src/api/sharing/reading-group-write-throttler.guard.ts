import { Injectable } from '@nestjs/common';
import {
  UserScopedThrottlerConfig,
  UserScopedThrottlerGuard,
} from '@/api/library/user-scoped-throttler.guard';

/**
 * Mutations des groupes de lecture (`POST /reading-groups`,
 * `POST /reading-groups/:id/invite`) : 10 par minute, par utilisateur et
 * par route — créer un groupe est une action rare.
 *
 * Quota PAR UTILISATEUR (cf. `UserScopedThrottlerGuard`) : l'ancien
 * `@Throttle()` tracké par IP était, derrière le reverse proxy, un budget
 * partagé par TOUS les utilisateurs. À placer APRÈS `JwtAuthGuard`.
 */
@Injectable()
export class ReadingGroupWriteThrottlerGuard extends UserScopedThrottlerGuard {
  /** Fenêtre de comptage (ms). */
  static readonly WINDOW_MS = 60_000;

  /** Quota par fenêtre et par utilisateur. */
  static readonly LIMIT = 10;

  /** Nom du throttler dédié — distinct du `default` global. */
  static readonly THROTTLER_NAME = 'reading-group-write';

  protected throttlerConfig(): UserScopedThrottlerConfig {
    return {
      name: ReadingGroupWriteThrottlerGuard.THROTTLER_NAME,
      ttl: ReadingGroupWriteThrottlerGuard.WINDOW_MS,
      limit: ReadingGroupWriteThrottlerGuard.LIMIT,
    };
  }
}
