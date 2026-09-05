import {
  forwardRef,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthHelper } from './auth.helper';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategy/accessTokenStrategy';
import User from '../user.entity';
import { RefreshTokenStrategy } from '@/api/user/auth/strategy/refreshTokenStrategy';
import { GoogleStrategy } from '@/api/user/auth/strategy/googleStrategy';
import { UserSession } from './user-session.entity';
import { EmailModule } from './email/email.module';
import { GoogleOAuthPopupMiddleware } from './google-oauth-popup.middleware';

@Module({
  imports: [
    JwtModule.register({}),
    TypeOrmModule.forFeature([User, UserSession]),
    forwardRef(() => EmailModule),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthHelper,
    JwtStrategy,
    RefreshTokenStrategy,
    GoogleStrategy,
  ],
  exports: [AuthService, AuthHelper],
})
export class AuthModule implements NestModule {
  /**
   * Connexion Google depuis le client web : la popup doit garder son
   * ouvreur (voir GoogleOAuthPopupMiddleware). Limité aux deux routes du
   * flux OAuth ; partout ailleurs le COOP strict de Helmet reste en place.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(GoogleOAuthPopupMiddleware)
      .forRoutes(
        { path: 'auth/google', method: RequestMethod.GET },
        { path: 'auth/google/callback', method: RequestMethod.GET },
      );
  }
}
