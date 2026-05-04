import { forwardRef, Module } from '@nestjs/common';
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
export class AuthModule {}
