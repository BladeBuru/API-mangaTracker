import { Injectable } from '@nestjs/common';
import {
  UserScopedThrottlerConfig,
  UserScopedThrottlerGuard,
} from './user-scoped-throttler.guard';

/**
 * Garde de rate-limiting PAR UTILISATEUR pour `PUT /library/reading-position`.
 *
 * La régulation réelle est côté client (le lecteur Flutter n'envoie sa
 * position qu'à intervalles espacés) : ce garde n'est qu'un plafond
 * anti-emballement — un client bogué en boucle de rendu ne doit pas pouvoir
 * marteler la base.
 *
 * 60 écritures/min et par utilisateur : deux ordres de grandeur au-dessus de
 * l'usage nominal (une écriture toutes les quelques secondes), assez bas pour
 * qu'une boucle folle soit coupée. Le bucket est nominatif — cf.
 * `UserScopedThrottlerGuard` : derrière NPMplus, un quota par IP serait un
 * budget partagé par tous les lecteurs.
 */
@Injectable()
export class ReadingPositionThrottlerGuard extends UserScopedThrottlerGuard {
  /** Fenêtre de 1 min (ms). */
  private static readonly WINDOW_MS = 60_000;

  /** Quota : 60 écritures de position par fenêtre et par utilisateur. */
  private static readonly LIMIT = 60;

  /** Nom du throttler dédié — distinct du `default` global. */
  private static readonly THROTTLER_NAME = 'reading-position';

  protected throttlerConfig(): UserScopedThrottlerConfig {
    return {
      name: ReadingPositionThrottlerGuard.THROTTLER_NAME,
      ttl: ReadingPositionThrottlerGuard.WINDOW_MS,
      limit: ReadingPositionThrottlerGuard.LIMIT,
    };
  }
}
