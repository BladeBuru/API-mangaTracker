import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Response } from 'express';
import { Observable } from 'rxjs';
import { GoogleOAuthPopupMiddleware } from './google-oauth-popup.middleware';

/**
 * Garde Google OAuth qui pose l'en-tête `Cross-Origin-Opener-Policy:
 * unsafe-none` **juste avant** que Passport n'écrive sa redirection.
 *
 * Pourquoi en plus du middleware de module (`GoogleOAuthPopupMiddleware`) :
 * c'est le dernier point d'exécution applicatif avant l'envoi de la réponse
 * 302 de `/auth/google` (Passport appelle `res.end()` lui-même). Poser
 * l'en-tête ici ne dépend d'aucun ordre d'enregistrement Express : quoi que
 * fasse un middleware global enregistré avant ou après, la valeur écrite
 * ici est celle qui part. Le middleware de module reste en place pour le
 * cas général ; l'en-tête `X-MT-Popup-Guard` sert uniquement à vérifier en
 * production quelle couche s'est exécutée.
 */
@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const res = context.switchToHttp().getResponse<Response>();
    res.setHeader(
      GoogleOAuthPopupMiddleware.HEADER,
      GoogleOAuthPopupMiddleware.POLICY,
    );
    res.setHeader('X-MT-Popup-Guard', '1');
    return super.canActivate(context);
  }
}
