import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  ClassSerializerInterceptor,
  UseInterceptors,
  UseGuards,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { RegisterDto, LoginDto, TokenDto } from './auth.dto';
import { AuthService } from './auth.service';
import User from '../user.entity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RefreshTokenGuard } from '@/api/user/auth/guard/refreshToken.guard';
import { AuthGuard } from '@nestjs/passport';
import { UserDecorator } from '@/shared/Decorator/user.decorator';
import { UserInformationDto } from '@/api/user/dto/user-information.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  @Inject(AuthService)
  private readonly service: AuthService;

  @ApiOperation({ summary: 'Register user' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 200, description: 'The found record', type: UserInformationDto })
  @Post('register')
  @UseInterceptors(ClassSerializerInterceptor)
  private register(@Body() body: RegisterDto): Promise<UserInformationDto> {
    return this.service.register(body);
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
      res.send(`
        <!DOCTYPE html>
        <html>
          <head><title>Connexion réussie</title></head>
          <body>
            <script>
              // Transmet les tokens à la fenêtre parente Flutter web
              if (window.opener) {
                window.opener.postMessage({
                  type: 'GOOGLE_AUTH_SUCCESS',
                  accessToken: '${tokens.accessToken}',
                  refreshToken: '${tokens.refreshToken}'
                }, '*');
                window.close();
              } else {
                document.body.innerHTML = '<p>Connexion réussie ! Vous pouvez fermer cette page.</p>';
              }
            </script>
          </body>
        </html>
      `);
    } else {
      res.redirect(`mangatracker://auth/callback?${params.toString()}`);
    }
  }
}
