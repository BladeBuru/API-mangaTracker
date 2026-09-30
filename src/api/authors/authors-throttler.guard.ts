import { Injectable } from '@nestjs/common';
import {
  UserScopedThrottlerConfig,
  UserScopedThrottlerGuard,
} from '@/api/library/user-scoped-throttler.guard';

/**
 * Quota PAR UTILISATEUR des fiches auteur : 60 par heure. Une fiche non
 * encore en cache coûte deux appels MangaUpdates ; sans ce quota, parcourir
 * les identifiants enverrait jusqu'au double de la limite globale de l'API
 * vers MangaUpdates — qui voit l'IP du serveur, pas celle de l'utilisateur.
 * À placer APRÈS `JwtAuthGuard`.
 */
@Injectable()
export class AuthorsThrottlerGuard extends UserScopedThrottlerGuard {
  private static readonly WINDOW_MS = 3_600_000;
  private static readonly LIMIT = 60;
  private static readonly THROTTLER_NAME = 'authors';

  protected throttlerConfig(): UserScopedThrottlerConfig {
    return {
      name: AuthorsThrottlerGuard.THROTTLER_NAME,
      ttl: AuthorsThrottlerGuard.WINDOW_MS,
      limit: AuthorsThrottlerGuard.LIMIT,
    };
  }
}
