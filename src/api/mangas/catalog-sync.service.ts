import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { CatalogHydrationService } from './catalog-hydration.service';
import { CatalogShardPlannerService } from './catalog-shard-planner.service';
import { CatalogShardRunnerService } from './catalog-shard-runner.service';
import { CatalogShard } from './catalog-shard';
import { CatalogSyncRunnableJob } from './catalog-sync-state.entity';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { intFromConfig } from './catalog-sync.mapper';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MuJobLockService } from './mu-job-lock.service';

/**
 * Synchronisation nightly du catalogue MangaUpdates vers la table `manga`,
 * **découpée en shards par année de publication**.
 *
 * ## Pourquoi le découpage (bug corrigé le 2026-08-28)
 *
 * `total_hits` de `/series/search` est plafonné à 10 000 : une passe globale
 * ne peut pas voir au-delà. Pire, `CATALOG_SYNC_MAX_PAGES` (50) servait de
 * **plafond absolu de pagination** dans l'ancien `effectiveLastPage()` : la
 * passe s'arrêtait page 50, se déclarait `completed`, remettait le curseur à
 * 0 — et réingérait éternellement les mêmes ~5 000 titres alors que la
 * requête en exposait 10 000. Le curseur ne pouvait structurellement jamais
 * dépasser la page 50. Désormais le seul plafond est le plafond RÉEL de la
 * requête (`ceil(total_hits / 100)`) borné par le hard cap MU (400), et
 * `CATALOG_SYNC_PAGES_PER_RUN` — le budget de la nuit, réparti **à travers
 * les shards** — est le seul vrai frein (cf. `CatalogShardPlannerService`).
 *
 * ## Politique réseau (inchangée)
 *
 * MU ≈ 60 req/min anonyme : 1 requête / `CATALOG_SYNC_DELAY_MS` (2000 ms =
 * 30 req/min = 50 % du plafond), cron 03:30 + jitter 0-15 min, backoff
 * 5/10/20/40 s sur 429/5xx. Échec persistant → arrêt PROPRE : curseur
 * persisté, statut `partial`, `consecutive_failures++` — jamais avalé.
 *
 * ## Découpage du code (2026-09-05)
 *
 * La mécanique d'une passe de shard (curseur, pages, saturation, statut
 * partiel) vit dans `CatalogShardRunnerService`, partagée avec le job de
 * rattrapage du type. Ce service garde l'orchestration : file de shards,
 * budget de la nuit, disjoncteur, sous-découpage des années saturées.
 *
 * Anti-réentrance et exclusion mutuelle avec les autres jobs MU (`releases`,
 * `type-backfill`) : `MuJobLockService` (1 seul job MU à la fois).
 */
@Injectable()
export class CatalogSyncService {
  private readonly logger = new Logger(CatalogSyncService.name);

  /** Nom sous lequel ce job prend le verrou MU. */
  static readonly LOCK_NAME = 'catalog';

  /** Jitter max avant le run nightly (15 min). */
  private static readonly JITTER_MAX_MS = 15 * 60 * 1000;

  /**
   * Coupe-circuit : un shard en échec ne consomme AUCUN budget de page, donc
   * sans cette garde une panne MU ferait enchaîner la centaine de shards de
   * la file (~500 requêtes et des heures de backoff dans la même nuit). Ne
   * pas se faire bannir prime sur la couverture.
   */
  private static readonly MAX_CONSECUTIVE_SHARD_FAILURES = 3;

  private readonly enabled: boolean;
  private readonly pagesPerRun: number;

  /** Injectable pour les tests (jitter du cron uniquement). */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @InjectRepository(CatalogSyncState)
    private readonly stateRepository: Repository<CatalogSyncState>,
    private readonly runner: CatalogShardRunnerService,
    private readonly planner: CatalogShardPlannerService,
    private readonly hydrationService: CatalogHydrationService,
    private readonly lock: MuJobLockService,
    config: ConfigService,
  ) {
    const enabledRaw = config.get<string>('CATALOG_SYNC_ENABLED');
    // Défaut : activé, sauf en environnement de test.
    this.enabled =
      enabledRaw !== undefined && enabledRaw !== ''
        ? enabledRaw === 'true'
        : config.get<string>('NODE_ENV') !== 'test';
    this.pagesPerRun = intFromConfig(config, 'CATALOG_SYNC_PAGES_PER_RUN', 60);

    // `CATALOG_SYNC_MAX_PAGES` est DÉPRÉCIÉE : c'était elle qui bloquait le
    // curseur page 50. Lue uniquement pour signaler qu'elle ne fait plus rien.
    const legacyMaxPages = config.get<string>('CATALOG_SYNC_MAX_PAGES');
    if (legacyMaxPages) {
      this.logger.warn(
        `CATALOG_SYNC_MAX_PAGES=${legacyMaxPages} est ignorée depuis le ` +
          'découpage par année : elle plafonnait la pagination et empêchait le ' +
          'curseur de progresser. Utiliser CATALOG_SYNC_PAGES_PER_RUN.',
      );
    }
  }

  /** Cron nightly 03:30 (heure serveur) + jitter aléatoire 0-15 min. */
  @Cron('0 30 3 * * *')
  async handleNightlySync(): Promise<void> {
    if (!this.enabled) return;
    const jitterMs = Math.floor(
      Math.random() * CatalogSyncService.JITTER_MAX_MS,
    );
    this.logger.log(
      `Sync catalogue nightly dans ${Math.round(jitterMs / 1000)} s (jitter)`,
    );
    await this.sleep(jitterMs);
    await this.runOnce();
  }

  /**
   * Point d'entrée testable. Sans argument : file de shards (budget réparti
   * entre eux) puis hydratation des lignes incomplètes. Avec `jobName` : ce
   * job fixe uniquement. No-op (warn) si un autre job MU est en cours
   * (verrou partagé). `releases` en est EXCLU par le type : ce job a son
   * propre cron et son propre curseur (`CatalogReleasesService`).
   */
  async runOnce(jobName?: CatalogSyncRunnableJob): Promise<void> {
    if (!this.lock.tryAcquire(CatalogSyncService.LOCK_NAME)) {
      this.logger.warn(
        'Sync catalogue déjà en cours — run ignoré (anti-réentrance)',
      );
      return;
    }
    try {
      if (jobName === 'hydration') {
        await this.hydrationService.hydrateIncompleteRows();
        return;
      }
      if (jobName) {
        await this.runner.runShardPass(
          CatalogSyncService.fixedShard(jobName),
          this.pagesPerRun,
        );
        return;
      }
      await this.runShardedCatalog();
      await this.hydrationService.hydrateIncompleteRows();
    } finally {
      this.lock.release(CatalogSyncService.LOCK_NAME);
    }
  }

  /** Descripteur de shard d'un job fixe, pour un run ciblé. */
  private static fixedShard(
    jobName: 'catalog:rating' | 'catalog:week_pos',
  ): CatalogShard {
    const weekly = jobName === 'catalog:week_pos';
    return {
      jobName,
      kind: 'global',
      level: 0,
      orderby: weekly ? 'week_pos' : 'rating',
      pageCap: weekly ? 10 : undefined,
    };
  }

  /**
   * Parcourt la file de shards en dépensant le budget de pages de la nuit.
   *
   * **Reprise inter-shards** : la file est reconstruite à chaque run et exclut
   * les shards terminés encore frais. Le premier shard restant est donc celui
   * sur lequel la nuit précédente s'est arrêtée, et son curseur est intact —
   * aucune remise à zéro globale n'intervient jamais.
   */
  private async runShardedCatalog(): Promise<void> {
    const states = await this.stateRepository.find();
    const queue = this.planner.planQueue(states, new Date());
    if (queue.length === 0) {
      this.logger.log(
        'Catalogue : tous les shards sont à jour, rien à parcourir cette nuit',
      );
      return;
    }

    let remaining = this.pagesPerRun;
    let shardsTouched = 0;
    let consecutiveFailures = 0;
    for (let i = 0; i < queue.length && remaining > 0; i++) {
      const shard = queue[i];
      const outcome = await this.runner.runShardPass(shard, remaining);
      remaining -= outcome.pagesFetched;
      if (outcome.pagesFetched > 0) shardsTouched += 1;

      consecutiveFailures = outcome.failed ? consecutiveFailures + 1 : 0;
      if (
        consecutiveFailures >= CatalogSyncService.MAX_CONSECUTIVE_SHARD_FAILURES
      ) {
        this.logger.error(
          `Catalogue : ${consecutiveFailures} shards consécutifs en échec — ` +
            'run interrompu (MU probablement indisponible). Les curseurs sont ' +
            'conservés, la reprise se fera au prochain run.',
        );
        break;
      }

      // Saturation tout juste découverte : les sous-shards par genre entrent
      // dans la file immédiatement, sans attendre la nuit suivante. Les runs
      // ultérieurs les obtiennent du planificateur (`saturated` est persisté).
      if (outcome.newlySaturated) {
        queue.splice(i + 1, 0, ...this.planner.expandSaturatedShard(shard));
      }
    }

    this.logger.log(
      `Catalogue : ${this.pagesPerRun - remaining}/${
        this.pagesPerRun
      } page(s) ` +
        `ingérée(s) sur ${shardsTouched} shard(s), ${queue.length} shard(s) en file`,
    );
  }
}
