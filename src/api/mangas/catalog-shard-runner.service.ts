import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogPageIngestService } from './catalog-page-ingest.service';
import { CatalogShardPlannerService } from './catalog-shard-planner.service';
import { CatalogShard } from './catalog-shard';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { intFromConfig } from './catalog-sync.mapper';

/** Bilan d'une passe de shard, remonté à la boucle de budget de l'appelant. */
export interface ShardPassOutcome {
  /** Pages effectivement ingérées — décomptées du budget de la nuit. */
  pagesFetched: number;
  /** Saturation découverte pendant CETTE passe (déclenche le sous-découpage). */
  newlySaturated: boolean;
  /** La passe s'est terminée sur un échec (réseau ou DB) — coupe-circuit. */
  failed: boolean;
}

/**
 * Exécute UNE passe sur UN shard de catalogue : reprise au curseur persisté
 * dans `catalog_sync_state`, ingestion page par page (MU + backoff + upsert
 * via `CatalogPageIngestService`), persistance du curseur à chaque page,
 * arrêt propre sur échec, cadence 1 requête / `CATALOG_SYNC_DELAY_MS`.
 *
 * Extrait de `CatalogSyncService` (2026-09-05) à l'arrivée du job de
 * rattrapage du type (`CatalogTypeBackfillService`) : les deux jobs paginent
 * exactement de la même façon une requête `/series/search` (curseur, budget,
 * saturation, statut partiel). Dupliquer la boucle aurait ouvert la porte à
 * une divergence silencieuse sur la partie la plus sensible du système (la
 * reprise sans doublon ni trou) — une seule implémentation, testée une fois.
 *
 * Ce service ne décide PAS quoi parcourir ni combien : l'orchestration (file
 * de shards, budget global, disjoncteur) reste chez l'appelant.
 */
@Injectable()
export class CatalogShardRunnerService {
  private readonly logger = new Logger(CatalogShardRunnerService.name);

  /** Page max acceptée par MU (au-delà : 400 Bad Request). */
  static readonly MU_PAGE_HARD_CAP = 400;

  private readonly delayMs: number;

  /** Injectable pour les tests (évite les vrais timers). */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @InjectRepository(CatalogSyncState)
    private readonly stateRepository: Repository<CatalogSyncState>,
    private readonly ingestService: CatalogPageIngestService,
    private readonly planner: CatalogShardPlannerService,
    config: ConfigService,
  ) {
    this.delayMs = intFromConfig(config, 'CATALOG_SYNC_DELAY_MS', 2000);
  }

  /**
   * Une passe sur un shard : reprend à son curseur persisté et ingère au plus
   * `budget` pages (curseur persisté page par page). Dernière page atteinte →
   * curseur remis à 0 et `completed_at` horodatée, ce qui sort le shard de la
   * file jusqu'à sa prochaine fenêtre de rafraîchissement.
   */
  async runShardPass(
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
   * précisément le bug corrigé le 2026-08-28.
   */
  private effectiveLastPage(
    totalPages: number | null,
    shard: CatalogShard,
  ): number {
    const cap = Math.min(
      shard.pageCap ?? CatalogShardRunnerService.MU_PAGE_HARD_CAP,
      CatalogShardRunnerService.MU_PAGE_HARD_CAP,
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
