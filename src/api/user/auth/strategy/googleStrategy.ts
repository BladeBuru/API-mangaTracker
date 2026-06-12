import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { AuthService } from '../auth.service';
import { TokenDto } from '../auth.dto';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly logger = new Logger(GoogleStrategy.name);

  constructor(private readonly authService: AuthService) {
    super({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
      scope: ['email', 'profile'],
    });
    this.logger.log(`✅ GoogleStrategy initialisée`);
    this.logger.log(
      `   CLIENT_ID   : ${process.env.GOOGLE_CLIENT_ID?.slice(0, 20)}...`,
    );
    this.logger.log(`   CALLBACK_URL: ${process.env.GOOGLE_CALLBACK_URL}`);
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ): Promise<void> {
    // RGPD : ne jamais logger email ni displayName (règle projet).
    this.logger.log(`🔑 Google callback reçu (googleId: ${profile?.id})`);
    const { id, emails, displayName } = profile;
    const email = emails?.[0]?.value;
    try {
      const tokens: TokenDto = await this.authService.findOrCreateGoogleUser(
        id,
        email,
        displayName,
      );
      this.logger.log('✅ Utilisateur Google authentifié');
      done(null, tokens);
    } catch (err) {
      this.logger.error(`❌ Erreur lors de findOrCreateGoogleUser : ${err}`);
      done(err, false);
    }
  }
}
