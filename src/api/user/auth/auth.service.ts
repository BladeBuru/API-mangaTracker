import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RegisterDto, LoginDto, TokenDto, GoogleMobileLoginDto } from './auth.dto';
import { AuthHelper } from './auth.helper';
import User, { AuthProvider } from '../user.entity';
import { UserInformationDto } from '@/api/user/dto/user-information.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  @InjectRepository(User)
  private readonly repository: Repository<User>;

  @Inject(AuthHelper)
  private readonly helper: AuthHelper;

  public async register(body: RegisterDto): Promise<User> {
    const { name, email, password }: RegisterDto = body;
    let user: User = await this.repository.findOne({ where: { email } });

    if (user) {
      throw new HttpException('Conflict', HttpStatus.CONFLICT);
    }

    user = new User();
    user.username = name;
    user.email = email;
    user.password = this.helper.encodePassword(password);
    user.authProvider = AuthProvider.LOCAL;

    // Retourne l'entité (avec id généré) pour permettre au caller de
    // déclencher l'envoi du mail de vérification post-inscription.
    return this.repository.save(user);
  }

  public async login(body: LoginDto): Promise<TokenDto> {
    const { email, password, deviceInfo }: LoginDto = body;
    const user: User = await this.repository.findOne({ where: { email } });

    if (!user) {
      throw new HttpException('No user found', HttpStatus.NOT_FOUND);
    }

    if (user.authProvider !== AuthProvider.LOCAL || !user.password) {
      throw new HttpException(
        'Ce compte utilise une connexion sociale (Google). Connectez-vous via Google.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const isPasswordValid: boolean = this.helper.isPasswordValid(
      password,
      user.password,
    );

    if (!isPasswordValid) {
      throw new HttpException('No user found', HttpStatus.NOT_FOUND);
    }

    await this.repository.update(user.id, { lastLoginAt: new Date() });

    // Crée une nouvelle session pour cet appareil (supporte le multi-appareils)
    const session = await this.helper.createSession(user, deviceInfo);
    return this.helper.generateToken(user, session.id);
  }

  /** Rotation du refresh token : invalide l'ancienne session, crée une nouvelle */
  public async refresh(user: User, sessionId: string): Promise<TokenDto> {
    const existingSession = await this.helper.findSession(sessionId);

    if (!existingSession) {
      throw new HttpException(
        'Session invalide ou expirée. Reconnectez-vous.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    await this.helper.deleteSession(sessionId);
    const newSession = await this.helper.createSession(
      user,
      existingSession.deviceInfo,
    );

    await this.repository.update(user.id, { lastLoginAt: new Date() });
    return this.helper.generateToken(user, newSession.id);
  }

  /** Déconnexion d'un appareil spécifique */
  public async logout(sessionId: string): Promise<void> {
    await this.helper.deleteSession(sessionId);
  }

  /**
   * Émet un nouveau couple `{accessToken, refreshToken}` pour un userId
   * sans vérifier le mot de passe. Utilisé après une vérification email
   * ou un reset password réussis (auto-login).
   *
   * Sécurité : à n'appeler QUE depuis un contexte qui a déjà validé
   * l'identité de l'utilisateur (token email vérifié, token reset
   * consommé, etc.). Ne JAMAIS exposer publiquement.
   */
  public async issueTokensForUserId(
    userId: number,
    deviceInfo?: string,
  ): Promise<TokenDto> {
    const user = await this.repository.findOne({ where: { id: userId } });
    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }
    await this.repository.update(user.id, { lastLoginAt: new Date() });
    const session = await this.helper.createSession(user, deviceInfo);
    return this.helper.generateToken(user, session.id);
  }

  /**
   * Invalide toutes les sessions actives d'un utilisateur. Utilisé après
   * un reset password : si un attaquant avait volé le refresh token, il
   * ne peut plus s'en servir.
   */
  public async revokeAllSessionsForUser(userId: number): Promise<void> {
    await this.helper.deleteAllSessions(userId);
  }

  /** Déconnexion de tous les appareils */
  public async logoutAll(userId: number): Promise<void> {
    await this.helper.deleteAllSessions(userId);
  }

  /**
   * Connexion mobile via google_sign_in Flutter.
   * Vérifie l'idToken avec Google et crée/retrouve l'utilisateur.
   */
  public async googleMobileLogin(dto: GoogleMobileLoginDto): Promise<TokenDto> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const client = new OAuth2Client(clientId);

    let payload: { sub?: string; email?: string; name?: string };
    try {
      const ticket = await client.verifyIdToken({
        idToken: dto.idToken,
        audience: clientId,
      });
      payload = ticket.getPayload() ?? {};
    } catch (err) {
      this.logger.error(`❌ Token Google mobile invalide: ${err}`);
      throw new HttpException('Token Google invalide ou expiré', HttpStatus.UNAUTHORIZED);
    }

    if (!payload.sub || !payload.email) {
      throw new HttpException('Token Google invalide (sub ou email manquant)', HttpStatus.UNAUTHORIZED);
    }

    this.logger.log(`🟢 Connexion Google mobile pour: ${payload.email}`);
    return this.findOrCreateGoogleUser(
      payload.sub,
      payload.email,
      payload.name ?? payload.email,
      dto.deviceInfo,
    );
  }

  /** Utilisé par Google OAuth pour trouver ou créer un utilisateur */
  public async findOrCreateGoogleUser(
    googleId: string,
    email: string,
    username: string,
    deviceInfo?: string,
  ): Promise<TokenDto> {
    let user = await this.repository.findOne({ where: { googleId } });

    if (!user) {
      // Vérifier si un compte local existe avec ce mail → liaison silencieuse
      user = await this.repository.findOne({ where: { email } });
      if (user) {
        // On ajoute juste le googleId sans changer authProvider :
        // l'utilisateur peut continuer à se connecter avec email/mot de passe ET Google
        user.googleId = googleId;
        await this.repository.save(user);
      } else {
        // Nouveau compte créé via Google
        user = this.repository.create({
          email,
          username,
          googleId,
          authProvider: AuthProvider.GOOGLE,
          password: null,
        });
        await this.repository.save(user);
      }
    }

    await this.repository.update(user.id, { lastLoginAt: new Date() });
    const session = await this.helper.createSession(user, deviceInfo);
    return this.helper.generateToken(user, session.id);
  }
}
