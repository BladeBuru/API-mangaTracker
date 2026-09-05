import { Injectable, Logger } from '@nestjs/common';

/**
 * Verrou in-process PARTAGÉ par tous les jobs qui frappent MangaUpdates en
 * tâche de fond (`releases` 02:00, `catalogue` 03:30, `type-backfill` 01:00
 * et son rattrapage des bibliothèques au démarrage).
 *
 * Pourquoi un verrou commun plutôt qu'un flag `running` par service (l'ancien
 * schéma) : chaque service se protégeait de sa PROPRE réentrance, mais rien
 * n'empêchait deux jobs différents de tourner en même temps — un déploiement
 * à 03:35 lançait le rattrapage des bibliothèques pendant la synchro du
 * catalogue, soit deux appels MU en parallèle et le double du débit convenu
 * (1 req / 2 s, ~30 req/min = 50 % du plafond anonyme). « Ne pas se faire
 * bannir » est l'exigence n°1 : un seul job MU à la fois, quel qu'il soit.
 *
 * Sémantique « skip, jamais attendre » : un job qui trouve le verrou pris se
 * retire (warn) et reprendra à son prochain créneau — ses curseurs sont
 * persistés, rien n'est perdu. Attendre ferait s'empiler les jobs et
 * déplacerait la charge sur des créneaux non prévus.
 *
 * In-process : 1 seul process API en prod. Si l'API passe multi-instance,
 * remplacer par un `pg_advisory_lock` (même contrat `tryAcquire`/`release`).
 */
@Injectable()
export class MuJobLockService {
  private readonly logger = new Logger(MuJobLockService.name);

  private holder: string | null = null;
  private acquiredAt: Date | null = null;

  /** Job qui détient le verrou, ou `null`. */
  get current(): string | null {
    return this.holder;
  }

  /**
   * Tente de prendre le verrou pour `jobName`. Retourne `false` (et logge
   * qui le détient) s'il est déjà pris — y compris par le même job.
   */
  tryAcquire(jobName: string): boolean {
    if (this.holder !== null) {
      this.logger.warn(
        `[${jobName}] verrou MU déjà détenu par « ${this.holder} » ` +
          `depuis ${this.acquiredAt?.toISOString() ?? '?'} — run ignoré`,
      );
      return false;
    }
    this.holder = jobName;
    this.acquiredAt = new Date();
    return true;
  }

  /** Libère le verrou si `jobName` le détient (no-op sinon). */
  release(jobName: string): void {
    if (this.holder !== jobName) return;
    this.holder = null;
    this.acquiredAt = null;
  }
}
