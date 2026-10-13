import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ClientIpRequest, extractClientIp } from './client-ip.util';

/**
 * Garde de rate-limiting GLOBAL (APP_GUARD) tracké par l'IP réelle du
 * client.
 *
 * Remplace le `ThrottlerGuard` d'origine, dont le tracker (`req.ip`)
 * renvoyait l'adresse du reverse proxy : les 100 req/min et toutes les
 * limites `@Throttle()` de route (auth, email, mot de passe, covers…)
 * étaient partagées par l'ensemble des utilisateurs — un seul client
 * bavard faisait répondre 429 à tout le monde.
 *
 * Mêmes throttlers, mêmes limites : seule la clé de comptage change.
 * Les routes d'écriture authentifiées utilisent en plus un quota PAR
 * UTILISATEUR (sous-classes de `UserScopedThrottlerGuard`).
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    return extractClientIp(req as ClientIpRequest);
  }
}
