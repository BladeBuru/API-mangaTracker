import { Injectable } from '@nestjs/common';
import {
  UserScopedThrottlerConfig,
  UserScopedThrottlerGuard,
} from '@/api/library/user-scoped-throttler.guard';

/**
 * Quota PAR UTILISATEUR des votes de recommandation : 60 écritures par
 * heure. Recommander ou retirer une recommandation est un geste ponctuel ;
 * la limite ne vise que l'abus scripté (gonfler un compteur public).
 * À placer APRÈS `JwtAuthGuard`.
 */
@Injectable()
export class CommunityThrottlerGuard extends UserScopedThrottlerGuard {
  private static readonly WINDOW_MS = 3_600_000;
  private static readonly LIMIT = 60;
  private static readonly THROTTLER_NAME = 'community-recommendations';

  protected throttlerConfig(): UserScopedThrottlerConfig {
    return {
      name: CommunityThrottlerGuard.THROTTLER_NAME,
      ttl: CommunityThrottlerGuard.WINDOW_MS,
      limit: CommunityThrottlerGuard.LIMIT,
    };
  }
}
