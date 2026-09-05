import { ExecutionContext } from '@nestjs/common';
import { GoogleOAuthGuard } from './google-oauth.guard';

/**
 * Le garde pose l'en-tête COOP juste avant de déléguer à Passport : c'est
 * la garantie que la redirection 302 de `/auth/google` part avec
 * `unsafe-none`, quel que soit l'ordre des middlewares Express.
 */
describe('GoogleOAuthGuard', () => {
  const headers = new Map<string, string>();
  const res = {
    setHeader: (name: string, value: string) => headers.set(name, value),
  };
  const context = {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ExecutionContext;

  beforeEach(() => {
    headers.clear();
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  });

  it('should set unsafe-none before delegating to Passport', async () => {
    const guard = new GoogleOAuthGuard();
    // La classe parente (mixin AuthGuard('google')) exige une stratégie
    // Passport enregistrée : on l'isole, seul l'en-tête nous intéresse ici.
    const parentProto = Object.getPrototypeOf(GoogleOAuthGuard.prototype);
    const parentCanActivate = jest
      .spyOn(parentProto, 'canActivate')
      .mockResolvedValue(true);

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('unsafe-none');
    expect(headers.get('X-MT-Popup-Guard')).toBe('1');
    expect(parentCanActivate).toHaveBeenCalledTimes(1);
    parentCanActivate.mockRestore();
  });
});
