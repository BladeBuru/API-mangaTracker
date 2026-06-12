import { Injectable, Logger } from '@nestjs/common';

/**
 * Cache in-memory des recommandations finales par utilisateur
 * (spec hotfix-v0-10-1 US-4).
 *
 * Avant : chaque `GET /api/recommendations` recalculait tout (5-8 queries +
 * fetch MU bloquant potentiel) → 500-3000 ms et résultats instables entre
 * deux visites. Désormais le résultat est mis en cache 1h par
 * `(userId, variante)` et invalidé dès que la bibliothèque de l'utilisateur
 * change (l'ajout d'un manga doit se refléter immédiatement).
 *
 * In-memory volontaire : une seule instance API en prod — pas besoin de
 * Redis (tech-design D5). Si l'API devient multi-instance, remplacer par
 * un store partagé.
 */
@Injectable()
export class RecoCacheService {
  private readonly logger = new Logger(RecoCacheService.name);

  /** TTL d'une entrée : 1h. */
  private static readonly TTL_MS = 60 * 60 * 1000;

  /** Garde-fou mémoire : au-delà, purge complète (cache = optimisation). */
  private static readonly MAX_ENTRIES = 5000;

  private readonly store = new Map<
    string,
    { expiresAt: number; data: unknown }
  >();

  /** Clés actives par userId — permet l'invalidation ciblée O(k). */
  private readonly keysByUser = new Map<number, Set<string>>();

  /**
   * @param variant identifie la forme de la requête, ex.
   *  `flat:all:50:0` (liste paginée) ou `byGenre:5:10` (sections home).
   */
  get<T>(userId: number, variant: string): T | null {
    const key = `${userId}:${variant}`;
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(userId: number, variant: string, data: T): void {
    if (this.store.size >= RecoCacheService.MAX_ENTRIES) {
      this.logger.warn('Reco cache full — flushing');
      this.store.clear();
      this.keysByUser.clear();
    }
    const key = `${userId}:${variant}`;
    this.store.set(key, {
      expiresAt: Date.now() + RecoCacheService.TTL_MS,
      data,
    });
    let keys = this.keysByUser.get(userId);
    if (!keys) {
      keys = new Set();
      this.keysByUser.set(userId, keys);
    }
    keys.add(key);
  }

  /**
   * Invalide toutes les entrées d'un user. À appeler sur TOUTE mutation de
   * sa bibliothèque (ajout, suppression, statut, chapitre, note) — ses recos
   * doivent refléter le changement immédiatement, pas dans 1h.
   */
  invalidateUser(userId: number): void {
    const keys = this.keysByUser.get(userId);
    if (!keys) return;
    for (const key of keys) this.store.delete(key);
    this.keysByUser.delete(userId);
  }
}
