import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * MangaUpdates a répondu 429 (rate-limit).
 *
 * Levée par `MangasService.fetchAndCacheRecommendations` pour que les boucles
 * de fetch amont (RecommendationService.fetchAndScoreBlocking) puissent
 * distinguer un throttling MU (→ pause 5 s avant le batch suivant) d'un échec
 * quelconque (→ skip silencieux).
 */
export class MuRateLimitException extends HttpException {
  constructor(muId: number) {
    super(
      `MangaUpdates rate limit (429) lors du fetch des recommandations du manga ${muId}`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
