import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard, IAuthGuard } from '@nestjs/passport';
import User from '../../user.entity';

/**
 * Garde des routes privées (access token).
 *
 * Jeton absent, expiré ou invalide → **401** (avant : 403, via un
 * `canActivate` qui renvoyait `false`). Le client rafraîchit sa session sur
 * un 401 ; sur un 403 il concluait à un refus et affichait « session
 * expirée » sans même essayer. Une erreur technique (base indisponible) est
 * propagée telle quelle au lieu d'être déguisée en refus.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') implements IAuthGuard {
  public handleRequest<TUser = User>(err: unknown, user: TUser): TUser {
    if (err) throw err;
    if (!user) throw new UnauthorizedException();
    return user;
  }

  public canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }
}
