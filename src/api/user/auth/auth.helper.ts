import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import User from '../user.entity';
import { TokenDto } from '@/api/user/auth/auth.dto';
import { UserSession } from './user-session.entity';

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
