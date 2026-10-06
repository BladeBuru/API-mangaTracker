import { Injectable, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthHelper } from '../auth.helper';
import User from '../../user.entity';

@Injectable()
export class RefreshTokenStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  @Inject(AuthHelper)
  private readonly helper: AuthHelper;

  constructor(@Inject(ConfigService) config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('JWT_REFRESH_SECRET'),
      ignoreExpiration: false,
      // Horloges serveur / appareil légèrement décalées : un jeton tout juste
      // expiré ou émis « dans le futur » n'est pas refusé pour 30 s d'écart.
      jsonWebTokenOptions: { clockTolerance: 30 },
    });
  }

  /** Retourne { user, sessionId } pour que le controller puisse faire la rotation de session */
  async validate(
    payload: any,
  ): Promise<{ user: User; sessionId: string } | null> {
    const user = await this.helper.validateUser(payload);
    // Compte supprimé : refus (401) plutôt qu'un utilisateur `null` qui
    // ferait planter la rotation.
    if (!user || !payload?.sessionId) return null;
    return { user, sessionId: payload.sessionId };
  }
}
