import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Forme minimale de la requête HTTP exploitée par le tracker.
 * `user` est injecté par `JwtAuthGuard` (passport) ; `ip` est le fallback.
 */
interface ThrottledRequest {
  user?: { id?: number | string };
  ip?: string;
}

/**
 * Rate-limiting PAR UTILISATEUR des routes de rejet de recommandations.
 *
 * Même raisonnement que `UserThrottlerGuard` (module Library) : l'API tourne
 * derrière le reverse proxy NPMplus, donc `req.ip` vaut l'IP du proxy pour
 * TOUS les utilisateurs — un `@Throttle()` tracké par IP deviendrait un
 * budget global partagé (déni de service mutuel). On tracke donc `req.user.id`
 * dans un throttler nommé, isolé du `default` global.
 *
 * Quota : **60 rejets par heure et par utilisateur**. Volontairement plus
 * large que le signalement de chapitres (10/h) : écarter des titres est un
 * geste de tri normal — un utilisateur qui nettoie sa home peut en écarter
 * plusieurs dizaines d'affilée. La limite ne vise que l'abus scripté.
 *
 * IMPORTANT : à placer APRÈS `JwtAuthGuard` dans `@UseGuards(...)` pour que
 * `req.user` soit renseigné.
 */
@Injectable()
export class DismissalThrottlerGuard extends ThrottlerGuard {
  /** Fenêtre de 1 h (ms). */
  private static readonly WINDOW_MS = 3_600_000;

  /** Quota : 60 rejets par fenêtre et par utilisateur. */
  private static readonly LIMIT = 60;

  /** Nom du throttler dédié — distinct du `default` global. */
  private static readonly THROTTLER_NAME = 'reco-dismissals';

  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = [
      {
        name: DismissalThrottlerGuard.THROTTLER_NAME,
        ttl: DismissalThrottlerGuard.WINDOW_MS,
        limit: DismissalThrottlerGuard.LIMIT,
      },
    ];
  }

  /**
   * Clé de rate-limit = `user-<id>` ; fallback sur l'IP si aucun user
   * (route protégée par `JwtAuthGuard` → cas défensif).
   */
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const { user, ip } = req as ThrottledRequest;
    const userId = user?.id;
    if (userId !== undefined && userId !== null) {
      return `user-${userId}`;
    }
    return ip ?? 'unknown';
  }
}
