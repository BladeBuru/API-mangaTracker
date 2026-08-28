import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogHydrationService } from './catalog-hydration.service';
import { CatalogPageIngestService } from './catalog-page-ingest.service';
import { CatalogShardPlannerService } from './catalog-shard-planner.service';
import { CatalogShard } from './catalog-shard';
import {
  CatalogSyncJobName,
  CatalogSyncState,
} from './catalog-sync-state.entity';
import { intFromConfig } from './catalog-sync.mapper';

/** Bilan d'une passe de shard, remonté à la boucle de budget. */
interface ShardPassOutcome {
  /** Pages effectivement ingérées — décomptées du budget de la nuit. */
  pagesFetched: number;
  /** Saturation découverte pendant CETTE passe (déclenche le sous-découpage). */
  newlySaturated: boolean;
  /** La passe s'est terminée sur un échec (réseau ou DB) — coupe-circuit. */
  failed: boolean;
}

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
 * Anti-réentrance : flag `running` in-process (1 seul process API en prod).
 * Si l'API passe multi-instance, remplacer par un `pg_advisory_lock`.
 */
@Injectable()
export class CatalogSyncService {
  private readonly logger = new Logger(CatalogSyncService.name);

  /** Page max acceptée par MU (au-delà : 400 Bad Request). */
  private static readonly MU_PAGE_HARD_CAP = 400;

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
  private readonly delayMs: number;

  /** Anti-réentrance in-process (voir doc de classe). */
  private running = false;

  /** Injectable pour les tests (évite les vrais timers). */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @InjectRepository(CatalogSyncState)
    private readonly stateRepository: Repository<CatalogSyncState>,
    private readonly ingestService: CatalogPageIngestService,
    private readonly planner: CatalogShardPlannerService,
    private readonly hydrationService: CatalogHydrationService,
    config: ConfigService,
  ) {
    const enabledRaw = config.get<string>('CATALOG_SYNC_ENABLED');
    // Défaut : activé, sauf en environnement de test.
    this.enabled =
      enabledRaw !== undefined && enabledRaw !== ''
        ? enabledRaw === 'true'
        : config.get<string>('NODE_ENV') !== 'test';
    this.pagesPerRun = intFromConfig(config, 'CATALOG_SYNC_PAGES_PER_RUN', 60);
    this.delayMs = intFromConfig(config, 'CATALOG_SYNC_DELAY_MS', 2000);

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
   * job fixe uniquement. No-op (warn) si un run est déjà en cours
   * (anti-réentrance).
   */
  async runOnce(jobName?: CatalogSyncJobName): Promise<void> {
    if (this.running) {
      this.logger.warn(
        'Sync catalogue déjà en cours — run ignoré (anti-réentrance)',
      );
      return;
    }
    this.running = true;
    try {
      if (jobName === 'hydration') {
        await this.hydrationService.hydrateIncompleteRows();
        return;
      }
      if (jobName) {
        await this.runShardPass(
          CatalogSyncService.fixedShard(jobName),
          this.pagesPerRun,
        );
        return;
      }
      await this.runShardedCatalog();
      await this.hydrationService.hydrateIncompleteRows();
    } finally {
      this.running = false;
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
      const outcome = await this.runShardPass(shard, remaining);
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

  /**
   * Une passe sur un shard : reprend à son curseur persisté et ingère au plus
   * `budget` pages (curseur persisté page par page). Dernière page atteinte →
   * curseur remis à 0 et `completed_at` horodatée, ce qui sort le shard de la
   * file jusqu'à sa prochaine fenêtre de rafraîchissement.
   */
  private async runShardPass(
    shard: CatalogShard,
    budget: number,
  ): Promise<ShardPassOutcome> {
    const state = await this.getOrCreateState(shard.jobName);
    let page = state.last_completed_page;
    let totalPages = state.total_pages;
    let pagesFetched = 0;
    let newlySaturated = false;
    let saturationWarned = false;

    while (pagesFetched < budget) {
      if (page >= this.effectiveLastPage(totalPages, shard)) break;
      const nextPage = page + 1;

      try {
        // fetch + upsert + persistance du curseur dans le MÊME try : une
        // erreur DB ne doit pas sortir sans mettre à jour le statut.
        const totalHits = await this.ingestService.ingestPage(shard, nextPage);
        pagesFetched += 1;
        page = nextPage;
        totalPages = Math.max(
          1,
          Math.ceil(totalHits / CatalogPageIngestService.PER_PAGE),
        );
        state.last_completed_page = page;
        state.total_pages = totalPages;
        state.total_hits = totalHits;

        if (CatalogShardPlannerService.isSaturated(totalHits)) {
          if (shard.level === 2) {
            // Niveau de découpage maximal : on signale le trou de couverture
            // une seule fois par passe plutôt qu'à chaque page, et on ne
            // sous-découpe pas davantage (récursion limitée à 2 niveaux).
            state.saturated = true;
            if (!saturationWarned) {
              this.planner.warnStillSaturated(shard, totalHits);
              saturationWarned = true;
            }
          } else if (!state.saturated) {
            state.saturated = true;
            newlySaturated = shard.level === 1;
          }
        }

        await this.stateRepository.save(state);
      } catch (err) {
        // Backoff épuisé, erreur non-retryable, OU erreur DB : arrêt PROPRE
        // (curseur conservé, upsert idempotent → reprise sans doublon).
        await this.persistPartial(
          state,
          page,
          totalPages,
          shard.jobName,
          nextPage,
          err,
        );
        return { pagesFetched, newlySaturated, failed: true };
      }

      // 1 requête / delayMs (30 req/min à 2000 ms = 50 % du plafond MU).
      await this.sleep(this.delayMs);
    }

    const done = page >= this.effectiveLastPage(totalPages, shard);
    state.last_completed_page = done ? 0 : page;
    state.total_pages = totalPages;
    state.last_run_at = new Date();
    state.last_run_status = done ? 'completed' : 'partial';
    if (done) {
      state.consecutive_failures = 0;
      // Horodatage de complétion : c'est lui qui met le shard au repos
      // jusqu'à sa prochaine fenêtre de rafraîchissement.
      state.completed_at = new Date();
    }
    try {
      await this.stateRepository.save(state);
    } catch (err) {
      this.logger.error(
        `[${shard.jobName}] échec de persistance du statut final : ${
          (err as Error)?.message ?? err
        }`,
      );
      return { pagesFetched, newlySaturated, failed: true };
    }
    if (pagesFetched > 0) {
      this.logger.log(
        `[${shard.jobName}] ${pagesFetched} page(s) ingérée(s) — ${
          done
            ? 'shard complété'
            : `budget épuisé, reprise à la page ${page + 1}`
        }`,
      );
    }
    return { pagesFetched, newlySaturated, failed: false };
  }

  /**
   * Persiste un arrêt PARTIEL d'une passe (échec réseau ou DB) : curseur
   * conservé, statut `partial`, `consecutive_failures++`, log warn. La
   * persistance du statut est best-effort — si la DB est la cause de l'échec,
   * on ne peut que logger. L'exception n'est PAS propagée, pour ne pas sauter
   * les shards suivants du run.
   */
  private async persistPartial(
    state: CatalogSyncState,
    page: number,
    totalPages: number | null,
    jobName: string,
    failedPage: number,
    err: unknown,
  ): Promise<void> {
    state.last_completed_page = page;
    state.total_pages = totalPages;
    state.last_run_at = new Date();
    state.last_run_status = 'partial';
    state.consecutive_failures += 1;
    this.logger.warn(
      `[${jobName}] arrêt partiel sur la page ${failedPage} : ${
        (err as Error)?.message ?? err
      } — reprise à la page ${page + 1} au prochain run`,
    );
    try {
      await this.stateRepository.save(state);
    } catch (saveErr) {
      this.logger.error(
        `[${jobName}] échec de persistance du statut partiel : ${
          (saveErr as Error)?.message ?? saveErr
        }`,
      );
    }
  }

  /**
   * Dernière page atteignable d'un shard : le plafond RÉEL de la requête
   * (`total_pages`), borné par le plafond propre au shard (`week_pos`) et par
   * le hard cap MU. `CATALOG_SYNC_MAX_PAGES` n'intervient plus — c'est
   * précisément le bug corrigé.
   */
  private effectiveLastPage(
    totalPages: number | null,
    shard: CatalogShard,
  ): number {
    const cap = Math.min(
      shard.pageCap ?? CatalogSyncService.MU_PAGE_HARD_CAP,
      CatalogSyncService.MU_PAGE_HARD_CAP,
    );
    return totalPages === null ? cap : Math.min(totalPages, cap);
  }

  private async getOrCreateState(jobName: string): Promise<CatalogSyncState> {
    const existing = await this.stateRepository.findOneBy({
      job_name: jobName,
    });
    if (existing) return existing;
    return this.stateRepository.create({
      job_name: jobName,
      last_completed_page: 0,
      total_pages: null,
      last_run_at: null,
      last_run_status: null,
      consecutive_failures: 0,
      completed_at: null,
      saturated: false,
      total_hits: null,
    });
  }
}
