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
 * Garde de rate-limiting PAR UTILISATEUR pour la route de signalement
 * `report-chapters`.
 *
 * Pourquoi un garde dédié plutôt que `@Throttle()` + `ThrottlerGuard` global :
 * l'API tourne derrière le reverse proxy NPMplus, donc `req.ip` vaut l'IP du
 * proxy pour TOUS les utilisateurs. Un `@Throttle({ limit: 10, ttl: 1h })`
 * tracké par IP devient alors un budget GLOBAL de 10/h partagé (déni de
 * service mutuel : 10 signalements par heure pour l'ensemble des users).
 *
 * Ce garde :
 *  - définit son PROPRE throttler nommé `report-chapters`, isolé du `default`
 *    global (clé de comptage distincte) — le `ThrottlerGuard` global
 *    (APP_GUARD) n'applique donc jamais cette limite stricte par IP ;
 *  - tracke par `req.user.id` (fallback IP défensif si non authentifié).
 *
 * IMPORTANT : à placer APRÈS `JwtAuthGuard` dans `@UseGuards(...)` pour que
 * `req.user` soit renseigné. Les gardes de route s'exécutent dans l'ordre
 * déclaré ; le garde global, lui, s'exécute AVANT l'auth (ordre NestJS :
 * global → class → method) et ne verrait jamais `req.user`.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  /** Fenêtre de 1 h (ms) du garde-fou anti-abus. */
  private static readonly WINDOW_MS = 3_600_000;

  /** Quota : 10 signalements par fenêtre et par utilisateur. */
  private static readonly LIMIT = 10;

  /** Nom du throttler dédié — distinct du `default` global. */
  private static readonly THROTTLER_NAME = 'report-chapters';

  async onModuleInit(): Promise<void> {
    // Réutilise le binding de base (commonOptions.getTracker = notre override
    // ci-dessous, par polymorphisme), puis remplace les throttlers injectés
    // (module `default`, 100/min) par un throttler dédié self-contained.
    await super.onModuleInit();
    this.throttlers = [
      {
        name: UserThrottlerGuard.THROTTLER_NAME,
        ttl: UserThrottlerGuard.WINDOW_MS,
        limit: UserThrottlerGuard.LIMIT,
      },
    ];
  }

  /**
   * Clé de rate-limit = `user-<id>` (bucket par utilisateur) ; fallback sur
   * l'IP si aucun user (route protégée par `JwtAuthGuard` → cas défensif).
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
