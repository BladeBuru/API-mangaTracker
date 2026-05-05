import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Ip,
  Logger,
  Post,
  ClassSerializerInterceptor,
  UseInterceptors,
  UseGuards,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { randomBytes } from 'crypto';
import { RegisterDto, LoginDto, TokenDto, GoogleMobileLoginDto } from './auth.dto';
import { AuthService } from './auth.service';
import User from '../user.entity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RefreshTokenGuard } from '@/api/user/auth/guard/refreshToken.guard';
import { AuthGuard } from '@nestjs/passport';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { UserInformationDto } from '@/api/user/dto/user-information.dto';
import { EmailService } from './email/email.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  @Inject(AuthService)
  private readonly service: AuthService;

  @Inject(EmailService)
  private readonly emailService: EmailService;

  @ApiOperation({ summary: 'Register user (envoie automatiquement un mail de vérification)' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 200, description: 'The found record', type: UserInformationDto })
  @Post('register')
  @UseInterceptors(ClassSerializerInterceptor)
  private async register(
    @Body() body: RegisterDto,
    @Ip() ip: string,
  ): Promise<UserInformationDto> {
    const user = await this.service.register(body);
    // Fire-and-forget : ne pas bloquer la réponse register si SMTP plante.
    // L'utilisateur peut toujours redemander un mail via /auth/email/send-verification.
    this.emailService
      .sendVerificationEmail(user.id, ip)
      .catch((err) =>
        this.logger.warn(
          `Failed to send verification email after register for userId=${user.id}: ${err?.message ?? err}`,
        ),
      );
    return UserInformationDto.fromEntity(user);
  }

  @ApiOperation({ summary: 'Login user (crée une session par appareil)' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 201, description: 'Tokens JWT', type: TokenDto })
  @Post('login')
  private login(@Body() body: LoginDto): Promise<TokenDto> {
    return this.service.login(body);
  }

  @ApiOperation({ summary: 'Refresh token avec rotation de session' })
  @ApiResponse({ status: 403, description: 'Session invalide ou expirée' })
  @ApiResponse({ status: 201, description: 'Nouveaux tokens JWT', type: TokenDto })
  @Post('refresh')
  @UseGuards(RefreshTokenGuard)
  private refresh(
    @UserDecorator() payload: { user: User; sessionId: string },
  ): Promise<TokenDto> {
    return this.service.refresh(payload.user, payload.sessionId);
  }

  @ApiOperation({ summary: 'Déconnexion de cet appareil' })
  @ApiResponse({ status: 204, description: 'Déconnecté' })
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RefreshTokenGuard)
  private logout(
    @UserDecorator() payload: { user: User; sessionId: string },
  ): Promise<void> {
    return this.service.logout(payload.sessionId);
  }

  @ApiOperation({ summary: 'Déconnexion de tous les appareils' })
  @ApiResponse({ status: 204, description: 'Déconnecté de tous les appareils' })
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard('jwt'))
  private logoutAll(
    @UserDecorator() user: User,
  ): Promise<void> {
    return this.service.logoutAll(user.id);
  }

  @ApiOperation({ summary: 'Connexion Google via app mobile (idToken google_sign_in)' })
  @ApiResponse({ status: 201, description: 'Tokens JWT', type: TokenDto })
  @Post('google/mobile')
  googleMobileLogin(@Body() body: GoogleMobileLoginDto): Promise<TokenDto> {
    return this.service.googleMobileLogin(body);
  }

  @ApiOperation({ summary: 'Connexion via Google — redirige vers Google' })
  @Get('google')
  @UseGuards(AuthGuard('google'))
  googleLogin(): void {
    this.logger.log('🔵 GET /auth/google — redirection vers Google initiée');
  }

  @ApiOperation({ summary: 'Callback Google OAuth — retourne les tokens JWT' })
  @ApiResponse({ status: 200, description: 'Tokens JWT', type: TokenDto })
  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  googleCallback(
    @UserDecorator() tokens: TokenDto,
    @Res() res: Response,
  ): void {
    this.logger.log('🟢 GET /auth/google/callback — callback Google reçu');
    if (!tokens?.accessToken) {
      this.logger.error('❌ Aucun token reçu dans le callback Google');
      res.status(500).send('Erreur lors de la récupération des tokens');
      return;
    }
    this.logger.log('✅ Tokens générés, redirection vers le deep link Flutter');
    const params = new URLSearchParams({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });

    // Mobile : deep link intercepté par le WebView de l'app
    // Web (dev) : page HTML qui transmet les tokens via postMessage ou affiche un code
    const ua = (res.req as any).headers['user-agent'] ?? '';
    const isWebBrowser = !ua.includes('Dart') && !ua.includes('Flutter');

    if (isWebBrowser) {
      // Override la CSP de Helmet pour cette réponse uniquement.
      // Le script inline ci-dessous fait `window.opener.postMessage` ; il est
      // autorisé via un nonce CSP unique par requête (script-src 'nonce-…').
      // C'est plus sûr que `'unsafe-inline'` global et plus simple qu'un hash
      // (qui changerait à chaque token).
      const nonce = randomBytes(16).toString('base64');
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'`,
      );
      // Échappe les tokens JWT pour le contexte JS (pas de quote possible mais
      // ceinture & bretelles : on encode pour éviter toute injection si un
      // jour le format change).
      const safeAccessToken = tokens.accessToken.replace(/[^a-zA-Z0-9._-]/g, '');
      const safeRefreshToken = tokens.refreshToken.replace(/[^a-zA-Z0-9._-]/g, '');
      res.send(`<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>Connexion réussie</title></head>
  <body>
    <p>Connexion réussie ! Vous pouvez fermer cette page.</p>
    <script nonce="${nonce}">
      (function () {
        var payload = {
          type: 'GOOGLE_AUTH_SUCCESS',
          accessToken: '${safeAccessToken}',
          refreshToken: '${safeRefreshToken}'
        };
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, '*');
          }
        } catch (e) { /* opener inaccessible (cross-origin) */ }
        // Tente de fermer la popup ; si bloqué (Brave/Safari), le user fermera
        // manuellement — le postMessage a déjà été envoyé.
        try { window.close(); } catch (e) {}
      })();
    </script>
  </body>
</html>`);
    } else {
      res.redirect(`mangatracker://auth/callback?${params.toString()}`);
    }
  }
}
