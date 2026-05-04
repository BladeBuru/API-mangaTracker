import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createTransport, Transporter } from 'nodemailer';
import * as Handlebars from 'handlebars';
import { readFileSync } from 'fs';
import { join } from 'path';
import User from '@/api/user/user.entity';
import { AuthTokenService } from './auth-token.service';
import { AuthTokenType } from './auth-token.entity';

type SupportedLang = 'fr' | 'en';

/**
 * Type d'email supporté. Un fichier `.hbs` du même nom doit exister dans
 * `templates/`.
 */
type EmailTemplate = 'verify-email' | 'reset-password';

/**
 * Service d'envoi d'emails transactionnels via le relay SMTP Brevo.
 *
 * Lit la config depuis `.env` :
 *  - SMTP_HOST (défaut: smtp-relay.brevo.com)
 *  - SMTP_PORT (défaut: 587)
 *  - SMTP_USER (login Brevo, ex: aa11e8001@smtp-brevo.com)
 *  - SMTP_PASSWORD (clé SMTP master)
 *  - SMTP_FROM (adresse expéditeur, ex: noreply@bladeburu.com)
 *  - SMTP_FROM_NAME (nom affiché, ex: "Manga Tracker")
 *  - PUBLIC_WEB_URL (base pour les liens, ex: https://bladeburu.com)
 *
 * Logs de sécurité :
 *  - JAMAIS le contenu de l'email (évite la fuite d'un token via les logs)
 *  - JAMAIS l'email destinataire (RGPD)
 *  - Seuls : `userId`, `template`, `success/error`
 *
 * Les templates sont chargés une fois au boot et compilés (perf).
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private readonly templates = new Map<
    EmailTemplate,
    HandlebarsTemplateDelegate
  >();

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly configService: ConfigService,
    private readonly authTokenService: AuthTokenService,
  ) {
    this.compileTemplates();
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Envoie un mail de vérification à l'utilisateur.
   * Génère un nouveau token (invalide les précédents). Échoue silencieusement
   * si déjà vérifié.
   */
  async sendVerificationEmail(userId: number, ip: string | null = null): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) return; // anti-énumération
    if (user.emailVerifiedAt) {
      this.logger.log(`sendVerificationEmail: userId=${userId} already verified, skip`);
      return;
    }

    const token = await this.authTokenService.createToken(
      userId,
      AuthTokenType.EmailVerify,
      ip,
    );

    const lang = this.detectLang(user);
    const verifyUrl = `${this.publicBaseUrl()}/auth/verify?token=${token}`;
    const subject =
      lang === 'fr'
        ? 'Vérifiez votre adresse email — Manga Tracker'
        : 'Verify your email — Manga Tracker';

    await this.send(user.email, subject, 'verify-email', {
      lang,
      isFr: lang === 'fr',
      username: user.username,
      verifyUrl,
      subject,
    });
    this.logger.log(`sendVerificationEmail: sent userId=${userId}`);
  }

  /**
   * Envoie un mail de reset password.
   * Anti-énumération : ne lance jamais d'exception si l'email n'existe pas
   * (le caller retourne 200 dans tous les cas).
   */
  async sendPasswordResetEmail(email: string, ip: string | null = null): Promise<void> {
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      // Silently ignore (anti-enumeration). On simule un délai pour
      // éviter le timing attack.
      await this.simulateDelay();
      return;
    }

    const token = await this.authTokenService.createToken(
      user.id,
      AuthTokenType.PasswordReset,
      ip,
    );

    const lang = this.detectLang(user);
    const resetUrl = `${this.publicBaseUrl()}/auth/reset-password?token=${token}`;
    const subject =
      lang === 'fr'
        ? 'Réinitialisation de votre mot de passe — Manga Tracker'
        : 'Reset your password — Manga Tracker';

    await this.send(user.email, subject, 'reset-password', {
      lang,
      isFr: lang === 'fr',
      username: user.username,
      resetUrl,
      subject,
    });
    this.logger.log(`sendPasswordResetEmail: sent userId=${user.id}`);
  }

  /**
   * Marque l'email comme vérifié si le token est valide.
   * @returns le `userId` du compte vérifié.
   */
  async verifyEmailToken(rawToken: string): Promise<number> {
    const userId = await this.authTokenService.verifyAndConsume(
      rawToken,
      AuthTokenType.EmailVerify,
    );
    await this.userRepository.update(userId, {
      emailVerifiedAt: new Date(),
    });
    this.logger.log(`Email verified for userId=${userId}`);
    return userId;
  }

  /**
   * Valide un token de reset et change le mot de passe.
   * @returns le `userId` modifié.
   */
  async confirmPasswordReset(
    rawToken: string,
    newPasswordHash: string,
  ): Promise<number> {
    const userId = await this.authTokenService.verifyAndConsume(
      rawToken,
      AuthTokenType.PasswordReset,
    );
    const result = await this.userRepository.update(userId, {
      password: newPasswordHash,
    });
    if (result.affected === 0) {
      throw new UnauthorizedException('User not found');
    }
    this.logger.log(`Password reset for userId=${userId}`);
    return userId;
  }

  // ─── Private helpers ────────────────────────────────────────────────

  private async send(
    to: string,
    subject: string,
    template: EmailTemplate,
    context: Record<string, unknown>,
  ): Promise<void> {
    const tpl = this.templates.get(template);
    if (!tpl) {
      throw new ServiceUnavailableException(`Email template '${template}' not loaded`);
    }
    const html = tpl(context);

    const transporter = await this.getTransporter();
    const fromAddress = this.configService.get<string>('SMTP_FROM') ??
      'noreply@bladeburu.com';
    const fromName = this.configService.get<string>('SMTP_FROM_NAME') ?? 'Manga Tracker';

    try {
      await transporter.sendMail({
        from: `"${fromName}" <${fromAddress}>`,
        to,
        subject,
        html,
      });
    } catch (err) {
      this.logger.error(
        `SMTP send failed (template=${template}): ${err instanceof Error ? err.message : err}`,
      );
      throw new ServiceUnavailableException('Email service temporarily unavailable');
    }
  }

  private compileTemplates(): void {
    const templateNames: EmailTemplate[] = ['verify-email', 'reset-password'];
    const templatesDir = join(__dirname, 'templates');

    for (const name of templateNames) {
      try {
        const filePath = join(templatesDir, `${name}.hbs`);
        const source = readFileSync(filePath, 'utf-8');
        this.templates.set(name, Handlebars.compile(source));
      } catch (err) {
        this.logger.warn(
          `Failed to load template '${name}': ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  private async getTransporter(): Promise<Transporter> {
    if (this.transporter) return this.transporter;

    const host = this.configService.get<string>('SMTP_HOST') ?? 'smtp-relay.brevo.com';
    const port = parseInt(this.configService.get<string>('SMTP_PORT') ?? '587', 10);
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASSWORD');

    if (!user || !pass) {
      throw new ServiceUnavailableException(
        'SMTP credentials not configured (SMTP_USER / SMTP_PASSWORD missing)',
      );
    }

    // Cast en `any` : les types nodemailer 7.x ont des unions strictes
    // (TransportOptions vs SMTPTransport.Options). En pratique cet objet
    // est l'option SMTP standard supportée par nodemailer.
    this.transporter = createTransport({
      host,
      port,
      secure: port === 465, // 465 → TLS direct ; 587 → STARTTLS
      auth: { user, pass },
      pool: false,
    } as any);

    return this.transporter;
  }

  private publicBaseUrl(): string {
    return (
      this.configService.get<string>('PUBLIC_WEB_URL') ?? 'https://bladeburu.com'
    );
  }

  /**
   * Détecte la langue préférée de l'utilisateur. À enrichir si on stocke
   * une préférence `language` sur User. Pour l'instant, fallback FR.
   */
  private detectLang(_user: User): SupportedLang {
    return 'fr';
  }

  /**
   * Délai aléatoire 100–400 ms pour homogénéiser les temps de réponse
   * entre cas où l'email existe et cas où il n'existe pas (anti-timing
   * attack côté reset password).
   */
  private async simulateDelay(): Promise<void> {
    const ms = 100 + Math.floor(Math.random() * 300);
    await new Promise((r) => setTimeout(r, ms));
  }
}
