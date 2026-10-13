import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  ClientIpRequest,
  extractClientIp,
} from '@/shared/throttling/client-ip.util';

/**
 * Forme minimale de la requête HTTP exploitée par le tracker.
 * `user` est injecté par `JwtAuthGuard` (passport) ; l'IP réelle du client
 * (cf. `extractClientIp`) est le fallback.
 */
interface ThrottledRequest extends ClientIpRequest {
  user?: { id?: number | string };
}

/** Configuration d'un throttler nommé, isolé du `default` global. */
export interface UserScopedThrottlerConfig {
  /** Nom du throttler — DOIT être distinct de `default`. */
  name: string;
  /** Fenêtre de comptage, en millisecondes. */
  ttl: number;
  /** Quota par fenêtre et par utilisateur. */
  limit: number;
}

/**
 * Base des gardes de rate-limiting **par utilisateur**.
 *
 * Pourquoi un garde dédié plutôt que `@Throttle()` + `ThrottlerGuard`
 * global : l'API tourne derrière le reverse proxy NPMplus, donc `req.ip`
 * vaut l'IP du proxy pour TOUS les utilisateurs. Un quota tracké par IP
 * devient alors un budget GLOBAL partagé (déni de service mutuel entre
 * utilisateurs).
 *
 * Chaque sous-classe :
 *  - déclare son PROPRE throttler nommé, isolé du `default` global (clé de
 *    comptage distincte) — le `ThrottlerGuard` global (APP_GUARD)
 *    n'applique donc jamais la limite stricte de la sous-classe ;
 *  - hérite du tracking par `req.user.id` (fallback IP défensif si non
 *    authentifié).
 *
 * IMPORTANT : à placer APRÈS `JwtAuthGuard` dans `@UseGuards(...)` pour que
 * `req.user` soit renseigné. Les gardes de route s'exécutent dans l'ordre
 * déclaré ; le garde global, lui, s'exécute AVANT l'auth (ordre NestJS :
 * global → class → method) et ne verrait jamais `req.user`.
 */
@Injectable()
export abstract class UserScopedThrottlerGuard extends ThrottlerGuard {
  /** Throttler dédié de la sous-classe (nom, fenêtre, quota). */
  protected abstract throttlerConfig(): UserScopedThrottlerConfig;

  async onModuleInit(): Promise<void> {
    // Réutilise le binding de base (commonOptions.getTracker = notre override
    // ci-dessous, par polymorphisme), puis remplace les throttlers injectés
    // (module `default`, 100/min) par un throttler dédié self-contained.
    await super.onModuleInit();
    this.throttlers = [this.throttlerConfig()];
  }

  /**
   * Clé de rate-limit = `user-<id>` (bucket par utilisateur) ; fallback sur
   * l'IP RÉELLE du client si aucun user (routes protégées par
   * `JwtAuthGuard` → cas défensif) — jamais `req.ip`, qui vaut l'adresse du
   * reverse proxy pour tout le monde.
   */
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as ThrottledRequest;
    const userId = request.user?.id;
    if (userId !== undefined && userId !== null) {
      return `user-${userId}`;
    }
    return extractClientIp(request);
  }
}
