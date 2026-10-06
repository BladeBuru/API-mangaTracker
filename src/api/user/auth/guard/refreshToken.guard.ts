import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Garde de `/auth/refresh` et `/auth/logout` (refresh token).
 * Jeton refusé → 401 explicite (cf. `JwtAuthGuard`).
 */
@Injectable()
export class RefreshTokenGuard extends AuthGuard('jwt-refresh') {
  public handleRequest<TUser>(err: unknown, user: TUser): TUser {
    if (err) throw err;
    if (!user) throw new UnauthorizedException();
    return user;
  }
}
