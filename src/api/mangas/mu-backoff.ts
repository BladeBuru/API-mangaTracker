import { Logger } from '@nestjs/common';
import { AxiosError } from 'axios';

/**
 * Politique de retry PARTAGÉE pour tous les appels MangaUpdates des jobs
 * nocturnes : 4 tentatives après l'appel initial, 5/10/20/40 s.
 *
 * Extraite de `CatalogPageIngestService` (2026-08-29) à l'arrivée du job
 * `releases` : deux jobs frappent désormais MU en nocturne et devaient
 * appliquer EXACTEMENT la même politique. Dupliquer la boucle aurait ouvert
 * la porte à une divergence silencieuse — or « ne pas se faire bannir » est
 * l'exigence n°1 de ce projet. Une seule implémentation, un seul jeu de
 * délais, un seul critère de retry.
 */
export const MU_BACKOFF_DELAYS_MS = [5_000, 10_000, 20_000, 40_000] as const;

/**
 * Seules erreurs retryables : 429 (rate limit) et 5xx (panne serveur). Un 4xx
 * autre qu'un 429 traduit une requête invalide — la réessayer ne ferait que
 * consommer du quota pour le même échec.
 */
export function isRetryableMuError(err: unknown): boolean {
  const status = (err as AxiosError)?.response?.status;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

/**
 * Exécute `attempt` avec le backoff MU standard.
 *
 * Toute erreur non retryable est **rethrow immédiatement** : c'est l'appelant
 * (job) qui décide de l'arrêt propre, en conservant son curseur. Une fois les
 * 4 retries épuisés, la dernière erreur est propagée telle quelle.
 *
 * @param attempt Appel réseau à (re)tenter.
 * @param label   Contexte loggé sur chaque retry (job + page).
 * @param sleep   Injecté pour que les tests n'attendent pas vraiment.
 */
export async function fetchWithMuBackoff<T>(
  attempt: () => Promise<T>,
  label: string,
  logger: Logger,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i <= MU_BACKOFF_DELAYS_MS.length; i++) {
    if (i > 0) {
      const delay = MU_BACKOFF_DELAYS_MS[i - 1];
      logger.warn(
        `MU ${label} : retry ${i}/${MU_BACKOFF_DELAYS_MS.length} dans ${delay} ms`,
      );
      await sleep(delay);
    }
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
      if (!isRetryableMuError(err)) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
