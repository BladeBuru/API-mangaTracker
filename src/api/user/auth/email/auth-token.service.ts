import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { randomBytes, createHash } from 'crypto';
import { AuthToken, AuthTokenType } from './auth-token.entity';

/**
 * TTL par type de token. Plus court = mieux. Le compromis UX impose
 * néanmoins de laisser le temps de retrouver l'email dans la boîte de
 * réception et de cliquer.
 */
const TOKEN_TTL_MS: Record<AuthTokenType, number> = {
  [AuthTokenType.EmailVerify]: 60 * 60 * 1000, // 60 min
  [AuthTokenType.PasswordReset]: 30 * 60 * 1000, // 30 min — plus sensible
};

/** Longueur du token brut en bytes (avant hex encoding). 32 bytes = 64 hex chars. */
const TOKEN_BYTES = 32;

/**
 * Service de gestion des tokens à usage unique pour les actions email
 * (vérification, reset password).
 *
 * Sécurité :
 *  - Token brut généré via `crypto.randomBytes(32)` (CSPRNG, 256 bits).
 *  - Stockage hashé SHA-256. Le token en clair ne quitte JAMAIS la mémoire :
 *    il est retourné une seule fois au caller (qui l'inclut dans l'email).
 *  - Lookup par hash → impossible de retrouver un token brut depuis la DB.
 *  - Comparaison via `tokenHash` direct (lookup index O(1)) — pas besoin de
 *    `timingSafeEqual` car le hash sert d'index, pas de secret comparé.
 *  - Single-use : `usedAt` set à `now()` → toute tentative de réutilisation
 *    échoue.
 *  - Invalidation des anciens tokens du même type lors de la création d'un
 *    nouveau (ex: nouveau « renvoyer le mail » → l'ancien lien ne marche
 *    plus).
 */
@Injectable()
export class AuthTokenService {
  private readonly logger = new Logger(AuthTokenService.name);

  constructor(
    @InjectRepository(AuthToken)
    private readonly tokenRepository: Repository<AuthToken>,
  ) {}

  /**
   * Génère un nouveau token pour l'utilisateur, l'enregistre hashé en DB,
   * et retourne le token brut (à inclure dans le lien email).
   *
   * **Le token brut n'est retourné qu'une fois, ici.** Il faut l'envoyer
   * dans l'email immédiatement.
   *
   * Effet de bord : invalide tous les autres tokens du même `(user, type)`
   * non encore utilisés (on garde un seul lien actif à la fois).
   */
  async createToken(
    userId: number,
    type: AuthTokenType,
    createdIp: string | null = null,
  ): Promise<string> {
    // Invalider les anciens tokens non utilisés du même type
    await this.tokenRepository
      .createQueryBuilder()
      .update(AuthToken)
      .set({ usedAt: new Date() })
      .where('user_id = :userId AND type = :type AND usedAt IS NULL', {
        userId,
        type,
      })
      .execute();

    // Token brut cryptographiquement sûr
    const rawToken = randomBytes(TOKEN_BYTES).toString('hex');
    const tokenHash = this.hashToken(rawToken);

    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS[type]);

    await this.tokenRepository.save({
      userId,
      tokenHash,
      type,
      expiresAt,
      createdIp,
    });

    return rawToken;
  }

  /**
   * Valide un token brut reçu d'un client et le marque comme consommé.
   * Lance `BadRequestException` avec un message générique en cas d'échec
   * (jamais de détail "token expiré" vs "token déjà utilisé" — on évite
   * de fournir des informations à un attaquant).
   *
   * @returns `userId` du propriétaire du token, validé.
   */
  async verifyAndConsume(
    rawToken: string,
    expectedType: AuthTokenType,
  ): Promise<number> {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new BadRequestException('Invalid token');
    }

    const tokenHash = this.hashToken(rawToken);
    const token = await this.tokenRepository.findOne({
      where: { tokenHash, type: expectedType },
    });

    // Réponse uniforme pour tous les cas d'échec (anti-énumération)
    const genericFailure = () =>
      new BadRequestException('Invalid or expired token');

    if (!token) throw genericFailure();
    if (token.usedAt !== null) throw genericFailure();
    if (token.expiresAt < new Date()) throw genericFailure();

    // Marquer comme consommé (atomique — si la même requête arrive en
    // double, la deuxième ne retrouve pas un token avec usedAt = null)
    const result = await this.tokenRepository
      .createQueryBuilder()
      .update(AuthToken)
      .set({ usedAt: new Date() })
      .where('id = :id AND usedAt IS NULL', { id: token.id })
      .execute();

    if (result.affected === 0) {
      // Race : un autre process a consommé le token entre le findOne et
      // l'update. Comportement attendu d'un single-use token.
      throw genericFailure();
    }

    return token.userId;
  }

  /**
   * Job de nettoyage à appeler périodiquement (cron) pour purger les tokens
   * expirés ou consommés depuis plus de 7 jours.
   */
  async cleanupOldTokens(): Promise<number> {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const result = await this.tokenRepository.delete({
      expiresAt: LessThan(cutoff),
    });
    const count = result.affected ?? 0;
    if (count > 0) {
      this.logger.log(`Cleaned up ${count} expired auth_token rows`);
    }
    return count;
  }

  /** SHA-256 hex du token brut. Utilisé comme clé de lookup unique. */
  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }
}
