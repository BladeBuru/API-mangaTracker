import { Injectable } from '@nestjs/common';
import {
  UserScopedThrottlerConfig,
  UserScopedThrottlerGuard,
} from '@/api/library/user-scoped-throttler.guard';

/**
 * Partage de manga (`POST /sharing/manga/:muId`) : 30 envois par minute et
 * par utilisateur (un envoi peut viser jusqu'à 20 amis).
 *
 * Quota PAR UTILISATEUR (cf. `UserScopedThrottlerGuard`) : l'ancien
 * `@Throttle()` tracké par IP était, derrière le reverse proxy, un budget
 * partagé par TOUS les utilisateurs. À placer APRÈS `JwtAuthGuard`.
 */
@Injectable()
export class MangaShareThrottlerGuard extends UserScopedThrottlerGuard {
  /** Fenêtre de comptage (ms). */
  static readonly WINDOW_MS = 60_000;

  /** Quota par fenêtre et par utilisateur. */
  static readonly LIMIT = 30;

  /** Nom du throttler dédié — distinct du `default` global. */
  static readonly THROTTLER_NAME = 'manga-share';

  protected throttlerConfig(): UserScopedThrottlerConfig {
    return {
      name: MangaShareThrottlerGuard.THROTTLER_NAME,
      ttl: MangaShareThrottlerGuard.WINDOW_MS,
      limit: MangaShareThrottlerGuard.LIMIT,
    };
  }
}
