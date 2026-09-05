import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

/**
 * Autorise la popup Google OAuth (client web) à garder un lien avec la
 * fenêtre qui l'a ouverte.
 *
 * Helmet pose `Cross-Origin-Opener-Policy: same-origin` sur TOUTES les
 * réponses de l'API. Or le client web ouvre `/auth/google` dans une popup
 * depuis `app.bladeburu.com` (autre origine) : dès que la popup reçoit une
 * réponse de l'API portant ce COOP, le navigateur la place dans un nouveau
 * groupe de contextes et `window.opener` devient `null`. Le script de la page
 * de callback ne peut alors plus faire `window.opener.postMessage(...)`, et
 * l'application web attend des jetons qui n'arriveront jamais.
 *
 * Sur ces deux routes — et elles seules — on renvoie `unsafe-none`, c'est-à-
 * dire le comportement historique du navigateur : la popup conserve son
 * ouvreur. Aucune donnée n'est exposée : le callback ne transmet les jetons
 * qu'au script de la page d'origine via `postMessage`, et les autres
 * en-têtes Helmet (CSP à nonce, CORP, etc.) restent inchangés.
 */
@Injectable()
export class GoogleOAuthPopupMiddleware implements NestMiddleware {
  static readonly HEADER = 'Cross-Origin-Opener-Policy';
  static readonly POLICY = 'unsafe-none';

  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader(
      GoogleOAuthPopupMiddleware.HEADER,
      GoogleOAuthPopupMiddleware.POLICY,
    );
    next();
  }
}
