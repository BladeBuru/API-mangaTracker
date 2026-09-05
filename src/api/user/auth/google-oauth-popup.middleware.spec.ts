import { NextFunction, Request, Response } from 'express';
import { GoogleOAuthPopupMiddleware } from './google-oauth-popup.middleware';

/**
 * Connexion Google sur le web : la popup doit conserver `window.opener`.
 * Sans cet en-tête, le COOP `same-origin` posé par Helmet coupe la popup de
 * la page d'origine et les jetons ne sont jamais transmis.
 */
describe('GoogleOAuthPopupMiddleware', () => {
  let middleware: GoogleOAuthPopupMiddleware;
  let res: Pick<Response, 'setHeader'>;
  let next: jest.Mock<ReturnType<NextFunction>>;

  beforeEach(() => {
    middleware = new GoogleOAuthPopupMiddleware();
    res = { setHeader: jest.fn() };
    next = jest.fn();
  });

  it('should relax Cross-Origin-Opener-Policy so the popup keeps its opener', () => {
    middleware.use({} as Request, res as Response, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Cross-Origin-Opener-Policy',
      'unsafe-none',
    );
  });

  it('should hand over to the next handler exactly once', () => {
    middleware.use({} as Request, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should override a value already set by Helmet', () => {
    // Helmet s'exécute avant : la valeur globale est déjà posée. Un
    // `setHeader` ultérieur la remplace (contrairement à `append`).
    const headers = new Map<string, string>([
      ['Cross-Origin-Opener-Policy', 'same-origin'],
    ]);
    const realisticRes = {
      setHeader: (name: string, value: string) => headers.set(name, value),
    } as unknown as Response;

    middleware.use({} as Request, realisticRes, next);

    expect(headers.get('Cross-Origin-Opener-Policy')).toBe('unsafe-none');
  });
});
