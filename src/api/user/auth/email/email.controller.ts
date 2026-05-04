import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Ip,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import * as bcrypt from 'bcryptjs';
import { JwtAuthGuard } from '@/api/user/auth/guard/auth.guard';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import User from '@/api/user/user.entity';
import { AuthService } from '@/api/user/auth/auth.service';
import { EmailService } from './email.service';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ConfirmPasswordResetDto } from './dto/confirm-password-reset.dto';

/**
 * Endpoints liés au flow email-driven : vérification d'email + reset
 * de mot de passe.
 *
 * Sécurité :
 *  - Throttling agressif (5 req/min) sur tous les endpoints d'envoi
 *    pour limiter les abus (spam email + énumération de comptes).
 *  - Anti-énumération : le reset request retourne 200 dans tous les
 *    cas. La vérification retourne un message générique en cas d'échec.
 *  - Auto-login après vérification : génère un nouveau couple JWT.
 *  - Reset password : invalide toutes les sessions existantes (force
 *    re-login partout, parade contre un attaquant qui aurait l'ancien
 *    refresh token).
 */
@ApiTags('Auth - Email')
@Controller('auth/email')
export class EmailController {
  private readonly logger = new Logger(EmailController.name);

  constructor(
    private readonly emailService: EmailService,
    @Inject(AuthService)
    private readonly authService: AuthService,
  ) {}

  // ─── Vérification d'email ───────────────────────────────────────────

  @ApiOperation({
    summary:
      "Renvoie un email de vérification à l'utilisateur connecté (cas : l'email d'inscription a été perdu).",
  })
  @ApiResponse({ status: 200, description: 'Email envoyé (ou déjà vérifié)' })
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60_000, limit: 3 } }) // 3 envois / minute max
  @UseGuards(JwtAuthGuard)
  @Post('send-verification')
  @HttpCode(200)
  async sendVerification(
    @UserDecorator() user: User,
    @Ip() ip: string,
  ): Promise<{ ok: true }> {
    await this.emailService.sendVerificationEmail(user.id, ip);
    return { ok: true };
  }

  @ApiOperation({
    summary:
      "Valide un token de vérification d'email. Marque le compte comme vérifié et retourne immédiatement un couple JWT (auto-login).",
  })
  @ApiResponse({
    status: 200,
    description: 'Email vérifié, tokens JWT retournés',
  })
  @ApiResponse({ status: 400, description: 'Token invalide ou expiré' })
  @Throttle({ default: { ttl: 60_000, limit: 10 } }) // 10 / min — anti-bruteforce
  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body() dto: VerifyEmailDto,
    @Ip() ip: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const userId = await this.emailService.verifyEmailToken(dto.token);
    // Auto-login : génère access + refresh comme à la connexion
    return this.authService.issueTokensForUserId(userId, ip);
  }

  // ─── Reset password ─────────────────────────────────────────────────

  @ApiOperation({
    summary:
      "Demande un email de reset password. Retourne TOUJOURS 200 (anti-énumération de comptes), même si l'email n'existe pas.",
  })
  @ApiResponse({
    status: 200,
    description:
      "Si un compte existe, un email a été envoyé. Sinon, réponse identique pour ne pas révéler l'existence du compte.",
  })
  @Throttle({ default: { ttl: 60_000, limit: 3 } }) // 3 / min, important
  @Post('password/reset/request')
  @HttpCode(200)
  async requestPasswordReset(
    @Body() dto: RequestPasswordResetDto,
    @Ip() ip: string,
  ): Promise<{ ok: true }> {
    await this.emailService.sendPasswordResetEmail(dto.email, ip);
    return { ok: true };
  }

  @ApiOperation({
    summary:
      'Confirme un reset password avec le token reçu par email + nouveau mot de passe. Invalide toutes les sessions actives en cascade.',
  })
  @ApiResponse({
    status: 200,
    description: 'Mot de passe changé, tokens JWT retournés (auto-login)',
  })
  @ApiResponse({ status: 400, description: 'Token invalide ou expiré' })
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('password/reset/confirm')
  @HttpCode(200)
  async confirmPasswordReset(
    @Body() dto: ConfirmPasswordResetDto,
    @Ip() ip: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const passwordHash = bcrypt.hashSync(dto.newPassword, bcrypt.genSaltSync(10));
    const userId = await this.emailService.confirmPasswordReset(
      dto.token,
      passwordHash,
    );

    // Sécurité : invalider toutes les sessions actives. L'attaquant qui
    // aurait un refresh token volé ne pourra plus s'en servir.
    await this.authService.revokeAllSessionsForUser(userId);

    return this.authService.issueTokensForUserId(userId, ip);
  }
}
