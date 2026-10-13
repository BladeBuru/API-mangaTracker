import { Injectable } from '@nestjs/common';
import {
  UserScopedThrottlerConfig,
  UserScopedThrottlerGuard,
} from '@/api/library/user-scoped-throttler.guard';

/**
 * Anti-spam des écritures de commentaires (`POST /mangas/:muId/comments`,
 * `POST /mangas/comments/:id/reply`, `POST /mangas/comments/:id/report`) :
 * 10 par heure, par utilisateur ET par route (la clé de comptage inclut le
 * handler, comme l'ancien `@Throttle()`).
 *
 * Quota PAR UTILISATEUR (cf. `UserScopedThrottlerGuard`) : l'ancien
 * `@Throttle()` tracké par IP était, derrière le reverse proxy, un budget
 * partagé par TOUS les utilisateurs. À placer APRÈS `JwtAuthGuard`.
 */
@Injectable()
export class CommentWriteThrottlerGuard extends UserScopedThrottlerGuard {
  /** Fenêtre de comptage (ms). */
  static readonly WINDOW_MS = 3_600_000;

  /** Quota par fenêtre et par utilisateur. */
  static readonly LIMIT = 10;

  /** Nom du throttler dédié — distinct du `default` global. */
  static readonly THROTTLER_NAME = 'comment-write';

  protected throttlerConfig(): UserScopedThrottlerConfig {
    return {
      name: CommentWriteThrottlerGuard.THROTTLER_NAME,
      ttl: CommentWriteThrottlerGuard.WINDOW_MS,
      limit: CommentWriteThrottlerGuard.LIMIT,
    };
  }
}
