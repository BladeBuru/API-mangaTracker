import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import User from '@/api/user/user.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { UserSession } from '@/api/user/auth/user-session.entity';

/**
 * Versions des documents légaux. Doit être incrémenté à chaque changement
 * majeur pour forcer la re-acceptation par les utilisateurs existants.
 *
 * Exposé aussi côté Flutter via /user/gdpr/legal-versions.
 */
export const CURRENT_TOS_VERSION = '1.0';
export const CURRENT_PRIVACY_VERSION = '1.0';

/**
 * Forme du paquet d'export RGPD (article 20 — droit à la portabilité).
 * Format JSON structuré, lisible et réutilisable. Volontairement sans
 * dépendance à un framework propriétaire (l'utilisateur peut l'importer
 * dans une autre app).
 */
export interface GdprExport {
  exportedAt: string;
  schemaVersion: '1';
  account: {
    id: number;
    username: string;
    email: string;
    authProvider: string;
    lastLoginAt: string | null;
    consent: {
      acceptedTosAt: string | null;
      acceptedTosVersion: string | null;
      acceptedPrivacyAt: string | null;
      acceptedPrivacyVersion: string | null;
    };
  };
  library: Array<{
    muId: string;
    title: string;
    addedAt: string;
    lastUpdated: string | null;
    readingStatus: string;
    readChapters: number;
    userRating: number;
    customLink: string | null;
  }>;
  sessions: Array<{
    id: number;
    createdAt: string;
    lastUsedAt: string | null;
    deviceInfo: string | null;
    isActive: boolean;
  }>;
}

@Injectable()
export class GdprService {
  private readonly logger = new Logger(GdprService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserManga)
    private readonly userMangaRepository: Repository<UserManga>,
    @InjectRepository(UserSession)
    private readonly sessionRepository: Repository<UserSession>,
  ) {}

  /**
   * Article 15 — Droit d'accès : retourne un résumé lisible des données
   * détenues sur l'utilisateur.
   */
  async getDataSummary(userId: number): Promise<{
    account: User;
    libraryCount: number;
    sessionsCount: number;
  }> {
    const account = await this.userRepository.findOne({
      where: { id: userId },
    });
    if (!account) throw new NotFoundException('User not found');

    // Ne JAMAIS retourner le hash du mot de passe
    delete (account as any).password;
    delete (account as any).googleId;

    const [libraryCount, sessionsCount] = await Promise.all([
      this.userMangaRepository.count({ where: { user: { id: userId } } }),
      this.sessionRepository.count({ where: { user: { id: userId } } }),
    ]);

    this.logger.log(`GDPR data summary requested by userId=${userId}`);
    return { account, libraryCount, sessionsCount };
  }

  /**
   * Article 20 — Droit à la portabilité : retourne un export JSON complet
   * des données utilisateur dans un format réutilisable.
   *
   * Le hash du mot de passe et le googleId ne sont JAMAIS inclus
   * (article 15 paragraphe 3 : « ne porte pas atteinte aux droits et
   * libertés d'autrui » — leur exposition créerait un risque de sécurité).
   */
  async exportUserData(userId: number): Promise<GdprExport> {
    const account = await this.userRepository.findOne({
      where: { id: userId },
    });
    if (!account) throw new NotFoundException('User not found');

    const [library, sessions] = await Promise.all([
      this.userMangaRepository.find({
        where: { user: { id: userId } },
        relations: ['manga'],
      }),
      this.sessionRepository.find({
        where: { user: { id: userId } },
      }),
    ]);

    this.logger.log(`GDPR data export requested by userId=${userId}`);

    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: '1',
      account: {
        id: account.id,
        username: account.username,
        email: account.email,
        authProvider: account.authProvider,
        lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
        consent: {
          acceptedTosAt: account.acceptedTosAt?.toISOString() ?? null,
          acceptedTosVersion: account.acceptedTosVersion,
          acceptedPrivacyAt: account.acceptedPrivacyAt?.toISOString() ?? null,
          acceptedPrivacyVersion: account.acceptedPrivacyVersion,
        },
      },
      library: library.map((um) => ({
        muId: um.manga?.mu_id ?? '',
        title: um.manga?.title ?? '',
        addedAt: um.adding_date.toISOString(),
        lastUpdated: um.lastUpdated?.toISOString() ?? null,
        readingStatus: um.readingStatus,
        readChapters: um.user_read_chapters,
        userRating: um.user_rating,
        customLink: um.custom_link,
      })),
      sessions: sessions.map((s: any) => ({
        id: s.id,
        createdAt: s.createdAt?.toISOString() ?? new Date().toISOString(),
        lastUsedAt: s.lastUsedAt?.toISOString() ?? null,
        deviceInfo: s.deviceInfo ?? null,
        isActive: s.isActive ?? false,
      })),
    };
  }

  /**
   * Enregistre l'acceptation du couple CGU + Politique de confidentialité.
   * Versions stockées pour pouvoir redemander en cas de mise à jour.
   *
   * Cette méthode doit être appelée :
   *  1. À l'inscription (consentement initial)
   *  2. Lors d'un changement de version (re-consentement)
   */
  async recordConsent(
    userId: number,
    tosVersion: string,
    privacyVersion: string,
  ): Promise<{ acceptedTosAt: Date; acceptedPrivacyAt: Date }> {
    const now = new Date();
    await this.userRepository.update(userId, {
      acceptedTosAt: now,
      acceptedTosVersion: tosVersion,
      acceptedPrivacyAt: now,
      acceptedPrivacyVersion: privacyVersion,
    });
    this.logger.log(
      `Consent recorded for userId=${userId} (ToS=${tosVersion}, Privacy=${privacyVersion})`,
    );
    return { acceptedTosAt: now, acceptedPrivacyAt: now };
  }

  /**
   * Vérifie si l'utilisateur doit re-accepter les CGU/Privacy (version
   * stockée < version courante). Utilisé pour afficher la modale de
   * re-consentement au prochain login.
   */
  needsConsentRefresh(user: User): {
    needsTosAcceptance: boolean;
    needsPrivacyAcceptance: boolean;
    currentTosVersion: string;
    currentPrivacyVersion: string;
  } {
    return {
      needsTosAcceptance: user.acceptedTosVersion !== CURRENT_TOS_VERSION,
      needsPrivacyAcceptance:
        user.acceptedPrivacyVersion !== CURRENT_PRIVACY_VERSION,
      currentTosVersion: CURRENT_TOS_VERSION,
      currentPrivacyVersion: CURRENT_PRIVACY_VERSION,
    };
  }
}
