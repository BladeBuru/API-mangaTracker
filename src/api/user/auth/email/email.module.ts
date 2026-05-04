import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import User from '@/api/user/user.entity';
import { AuthToken } from './auth-token.entity';
import { AuthTokenService } from './auth-token.service';
import { EmailService } from './email.service';
import { EmailController } from './email.controller';
import { AuthModule } from '@/api/user/auth/auth.module';

/**
 * Module dédié aux flows email-driven : vérification d'email + reset
 * password.
 *
 * Découplé d'AuthModule pour faciliter l'audit (un seul endroit où le
 * code SMTP / templates / tokens à usage unique vit).
 *
 * Dépend d'AuthModule pour `issueTokensForUserId` et
 * `revokeAllSessionsForUser` (auto-login après vérification).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([User, AuthToken]),
    ConfigModule,
    forwardRef(() => AuthModule),
  ],
  controllers: [EmailController],
  providers: [AuthTokenService, EmailService],
  exports: [AuthTokenService, EmailService],
})
export class EmailModule {}
