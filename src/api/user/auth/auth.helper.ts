import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import User from '../user.entity';
import { TokenDto } from '@/api/user/auth/auth.dto';
import { UserSession } from './user-session.entity';

/** Délai pendant lequel un refresh token déjà échangé redonne sa remplaçante. */
export const REFRESH_REPLAY_GRACE_MS = 2 * 60 * 1000;

/** Conservation des sessions échangées avant purge. */
const ROTATED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthHelper {
  @InjectRepository(User)
  private readonly repository: Repository<User>;

  @InjectRepository(UserSession)
  private readonly sessionRepository: Repository<UserSession>;

  private readonly jwt: JwtService;

  constructor(jwt: JwtService) {
    this.jwt = jwt;
  }

  public async decode(token: string): Promise<unknown> {
    return this.jwt.decode(token, null);
  }

  public async validateUser(decoded: any): Promise<User> {
    return this.repository.findOneBy({ id: decoded.id });
  }

  /** Génère un access token + refresh token pour une session donnée */
  public async generateToken(user: User, sessionId: string): Promise<TokenDto> {
    const dto = new TokenDto();
    dto.accessToken = await this.jwt.signAsync(
      { id: user.id },
      {
        secret: process.env.JWT_KEY,
        expiresIn: process.env.JWT_KEY_EXPIRES_IN,
      },
    );
    dto.refreshToken = await this.jwt.signAsync(
      { id: user.id, sessionId },
      {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: process.env.JWT_REFRESH_SECRET_EXPIRES_IN,
      },
    );
    return dto;
  }

  /** Crée une nouvelle session pour un appareil */
  public async createSession(
    user: User,
    deviceInfo?: string,
  ): Promise<UserSession> {
    const session = this.sessionRepository.create({
      id: randomUUID(),
      user,
      userId: user.id,
      deviceInfo: deviceInfo ?? null,
    });
    return this.sessionRepository.save(session);
  }

  /** Récupère une session par son ID */
  public async findSession(sessionId: string): Promise<UserSession | null> {
    return this.sessionRepository.findOne({
      where: { id: sessionId },
      relations: ['user'],
    });
  }

  /**
   * Échange un refresh token : renvoie l'id de la session à utiliser, ou
   * `null` si l'échange est refusé.
   *
   * - Première présentation : nouvelle session, l'ancienne est **marquée**
   *   échangée (plus supprimée sur-le-champ).
   * - Présentée de nouveau dans [REFRESH_REPLAY_GRACE_MS] : réponse perdue
   *   ou requêtes simultanées → on redonne la session de remplacement
   *   (la plus récente de la chaîne), au lieu de déconnecter l'appareil.
   * - Au-delà : refus (jeton réellement périmé).
   *
   * Sous verrou de ligne : deux échanges simultanés du même jeton sont
   * sérialisés et convergent vers la même session.
   */
  public async rotateSession(
    sessionId: string,
    now: Date = new Date(),
  ): Promise<string | null> {
    return this.sessionRepository.manager.transaction(async (manager) => {
      const sessions = manager.getRepository(UserSession);
      const session = await sessions.findOne({
        where: { id: sessionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!session) return null;

      if (!session.rotatedAt) {
        const next = sessions.create({
          id: randomUUID(),
          user: { id: session.userId } as User,
          userId: session.userId,
          deviceInfo: session.deviceInfo,
        });
        await sessions.save(next);
        session.rotatedAt = now;
        session.replacedById = next.id;
        await sessions.save(session);
        return next.id;
      }

      const age = now.getTime() - session.rotatedAt.getTime();
      if (age > REFRESH_REPLAY_GRACE_MS || !session.replacedById) return null;

      // Rejeu : suivre la chaîne jusqu'à la session courante.
      let currentId = session.replacedById;
      for (let hop = 0; hop < 5; hop++) {
        const current = await sessions.findOne({ where: { id: currentId } });
        if (!current) return null;
        if (!current.rotatedAt || !current.replacedById) return current.id;
        currentId = current.replacedById;
      }
      return null;
    });
  }

  /** Purge les sessions échangées depuis plus d'un jour (hors délai de grâce). */
  public async purgeRotatedSessions(userId: number): Promise<void> {
    await this.sessionRepository.delete({
      userId,
      rotatedAt: LessThan(new Date(Date.now() - ROTATED_SESSION_RETENTION_MS)),
    });
  }

  /** Supprime une session (logout d'un appareil) */
  public async deleteSession(sessionId: string): Promise<void> {
    await this.sessionRepository.delete({ id: sessionId });
  }

  /** Supprime toutes les sessions d'un utilisateur (logout global) */
  public async deleteAllSessions(userId: number): Promise<void> {
    await this.sessionRepository.delete({ userId });
  }

  public isPasswordValid(password: string, userPassword: string): boolean {
    return bcrypt.compareSync(password, userPassword);
  }

  public encodePassword(password: string): string {
    const salt: string = bcrypt.genSaltSync(10);
    return bcrypt.hashSync(password, salt);
  }
}
