import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthHelper } from './auth.helper';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategy/accessTokenStrategy';
import User from '../user.entity';
import { RefreshTokenStrategy } from '@/api/user/auth/strategy/refreshTokenStrategy';

@Module({
  imports: [JwtModule.register({}), TypeOrmModule.forFeature([User])],
  controllers: [AuthController],
  providers: [AuthService, AuthHelper, JwtStrategy, RefreshTokenStrategy],
})
export class AuthModule {}
