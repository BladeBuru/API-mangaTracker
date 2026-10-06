import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './auth.guard';
import { RefreshTokenGuard } from './refreshToken.guard';
import User from '../../user.entity';

describe('Gardes JWT', () => {
  const guards = [new JwtAuthGuard(), new RefreshTokenGuard()];

  it.each(guards)(
    'should answer 401 (not 403) when the token is missing or invalid — %p',
    (guard) => {
      expect(() => guard.handleRequest(null, null)).toThrow(
        UnauthorizedException,
      );
      expect(() => guard.handleRequest(null, false)).toThrow(
        UnauthorizedException,
      );
    },
  );

  it.each(guards)(
    'should propagate a technical error instead of disguising it — %p',
    (guard) => {
      const dbDown = new Error('connexion base perdue');
      expect(() => guard.handleRequest(dbDown, null)).toThrow(dbDown);
    },
  );

  it.each(guards)('should return the authenticated user — %p', (guard) => {
    const user = { id: 1 } as User;
    expect(guard.handleRequest(null, user)).toBe(user);
  });
});
