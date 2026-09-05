import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { Observable } from 'rxjs';

/**
 * Garde Google OAuth (client web) : la popup doit garder son ouvreur.
 *
 * Helmet pose `Cross-Origin-Opener-Policy: same-origin` sur TOUTES les
 * réponses de l'API. Or le client web ouvre `/auth/google` dans une popup
 * depuis `app.bladeburu.com` (autre origine) : dès que la popup reçoit une
 * réponse de l'API portant ce COOP, le navigateur la place dans un nouveau
 * groupe de contextes et `window.opener` devient `null`. Le script de la page
 * de callback ne peut alors plus faire `window.opener.postMessage(...)`, et
 * l'application web attend des jetons qui n'arriveront jamais.
 *
 * L'en-tête est posé ICI, juste avant que Passport n'écrive sa redirection
 * 302 (`res.end()` est appelé par Passport lui-même) : c'est le dernier point
 * d'exécution applicatif, indépendant de tout ordre d'enregistrement de
 * middleware. Un middleware de module (`AuthModule.configure`) avait été
 * essayé en premier : il passait les tests d'intégration mais ne s'exécutait
 * jamais en production (vérifié par en-tête témoin) — voir known-issues.md.
 *
 * Portée : les deux routes du flux OAuth uniquement. Partout ailleurs, le
 * COOP strict de Helmet reste en place. Aucune donnée n'est exposée : le
 * callback ne transmet les jetons qu'au script de la page d'origine.
 */
@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  static readonly HEADER = 'Cross-Origin-Opener-Policy';
  static readonly POLICY = 'unsafe-none';

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader(GoogleOAuthGuard.HEADER, GoogleOAuthGuard.POLICY);
    return super.canActivate(context);
  }
}
