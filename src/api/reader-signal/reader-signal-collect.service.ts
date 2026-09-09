import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { intFromConfig } from '@/api/mangas/catalog-sync.mapper';
import { NSFW_GENRES } from '@/api/mangas/constants';
import { MuJobLockService } from '@/api/mangas/mu-job-lock.service';
import { MuListsClient } from './mu-lists.client';
import { ReaderHashService } from './reader-hash.service';
import { ReaderSignalExtractionService } from './reader-signal-extraction.service';
import {
  DiscoveryTarget,
  ReaderSignalPriorityService,
} from './reader-signal-priority.service';
import {
  accumulate,
  emptyOutcome,
  formatCounts,
  ReaderSignalOutcome,
  ReaderSignalRunBudget,
} from './reader-signal-run';
import {
  PersistableSignalRow,
  ReaderSignalWriterService,
} from './reader-signal-writer.service';
import { READER_LIST_TYPES } from './reader-signal-weights';

export { ReaderSignalOutcome } from './reader-signal-run';

/**
 * Collecte nocturne du signal de lecture PUBLIC de MangaUpdates.
 *
 * ## Pourquoi
 *
 * Le moteur de recommandation n'a presque aucun signal : 6 comptes, 87
 * lignes de bibliothèque, 4 notes, 0 rejet. Le filtrage collaboratif est
 * impossible dans ces conditions. MangaUpdates expose des listes de lecture
 * publiques dont les identifiants de série **sont déjà les nôtres**
 * (`series_id` = `manga.mu_id`) : aucune correspondance à construire.
 *
 * ## Deux étages, un seul run
 *
 * 1. **Découverte** (ici) — `GET /lists/similar/{type}/{mu_id}` sur les
 *    séries prioritaires (`ReaderSignalPriorityService`). Chaque réponse est
 *    déjà du signal exploitable : elle donne, pour la série sondée, jusqu'à
 *    100 lecteurs avec leur note. Une requête de découverte n'est donc
 *    jamais « perdue », même si l'extraction ne suit pas. Mesuré le
 *    2026-09-09 : 43,9 lignes et 35,5 lecteurs uniques par requête.
 * 2. **Extraction** (`ReaderSignalExtractionService`) — pour les lecteurs
 *    découverts et non encore collectés, leurs listes publiques et leur
 *    contenu. 4,38 requêtes par lecteur.
 *
 * **Les deux étages sont couplés dans un même run, par conception RGPD** :
 * l'identifiant MangaUpdates en clair n'est jamais persisté, il n'existe que
 * dans la mémoire du run entre la découverte et l'extraction. Il ne peut
 * donc pas exister de file d'attente de lecteurs reportée au lendemain.
 *
 * ## Budget et cadence
 *
 * `READER_SIGNAL_BUDGET_PER_RUN` (défaut 1 000) requêtes par nuit, à
 * 1 requête / `CATALOG_SYNC_DELAY_MS` (2 s) — soit ~33 min de fenêtre. Le
 * verrou MU partagé (`MuJobLockService`) garantit qu'aucun autre job MU ne
 * tourne en parallèle : le débit global reste celui convenu avec MU.
 *
 * ## Créneau : 05:30
 *
 * Les créneaux MU occupés sont 01:00 (type), 02:00 (sorties), 03:30
 * (catalogue) et ~04:00 (hydratation). 05:30 laisse 90 min de marge après
 * l'hydratation et finit vers 06:05 dans le pire cas. Si un autre job
 * débordait jusque-là, le verrou partagé fait sauter ce run — les curseurs
 * sont persistés, rien n'est perdu.
 */
@Injectable()
export class ReaderSignalCollectService {
  private readonly logger = new Logger(ReaderSignalCollectService.name);

  /** Nom sous lequel ce job prend le verrou MU partagé. */
  static readonly LOCK_NAME = 'reader-signal';

  /** Jitter max avant le run nocturne (10 min), comme les autres jobs MU. */
  private static readonly JITTER_MAX_MS = 10 * 60 * 1000;

  private readonly enabled: boolean;
  private readonly budget: number;
  private readonly discoveryShare: number;
  private readonly typeDepth: number;
  private readonly readerTtlDays: number;
  private readonly maxFailures: number;
  private readonly readerMaxFailures: number;
  private readonly delayMs: number;

  /** Injectable pour les tests (évite les vrais timers). */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly client: MuListsClient,
    private readonly hasher: ReaderHashService,
    private readonly priority: ReaderSignalPriorityService,
    private readonly writer: ReaderSignalWriterService,
    private readonly extraction: ReaderSignalExtractionService,
    private readonly lock: MuJobLockService,
    config: ConfigService,
  ) {
    const enabledRaw = config.get<string>('READER_SIGNAL_ENABLED');
    this.enabled =
      enabledRaw !== undefined && enabledRaw !== ''
        ? enabledRaw === 'true'
        : config.get<string>('NODE_ENV') !== 'test';
    this.budget = intFromConfig(config, 'READER_SIGNAL_BUDGET_PER_RUN', 1000);
    const share = Number(config.get<string>('READER_SIGNAL_DISCOVERY_SHARE'));
    // 0,4 : la découverte alimente le vivier de lecteurs, l'extraction
    // élargit le vecteur de chacun — sans quoi il n'y a pas de
    // co-occurrence. Les deux sont nécessaires, la découverte est
    // prioritaire au démarrage (le vivier part de zéro).
    this.discoveryShare =
      Number.isFinite(share) && share > 0 && share < 1 ? share : 0.4;
    this.typeDepth = intFromConfig(config, 'READER_SIGNAL_TYPE_DEPTH', 1500);
    this.readerTtlDays = intFromConfig(
      config,
      'READER_SIGNAL_READER_TTL_DAYS',
      30,
    );
    this.maxFailures = intFromConfig(config, 'READER_SIGNAL_MAX_FAILURES', 5);
    this.readerMaxFailures = intFromConfig(
      config,
      'READER_SIGNAL_READER_MAX_FAILURES',
      3,
    );
    this.delayMs = intFromConfig(config, 'CATALOG_SYNC_DELAY_MS', 2000);
  }

  /** Cron nocturne 05:30 (heure serveur) + jitter 0-10 min. */
  @Cron('0 30 5 * * *')
  async handleNightlyCollect(): Promise<void> {
    if (!this.enabled) return;
    const jitterMs = Math.floor(
      Math.random() * ReaderSignalCollectService.JITTER_MAX_MS,
    );
    this.logger.log(
      `Collecte du signal de lecture dans ${Math.round(jitterMs / 1000)} s ` +
        '(jitter)',
    );
    await this.sleep(jitterMs);
    await this.runOnce();
  }

  /**
   * Point d'entrée testable. `null` si le sel de pseudonymisation manque ou
   * si un autre job MU tient le verrou.
   */
  async runOnce(): Promise<ReaderSignalOutcome | null> {
    if (!this.hasher.isConfigured) {
      this.logger.warn(
        'Collecte du signal de lecture ignorée : READER_SIGNAL_HASH_SALT ' +
          'absent ou trop court — aucune ligne ne sera écrite sans ' +
          'pseudonymisation (fail-closed volontaire)',
      );
      return null;
    }
    if (!this.lock.tryAcquire(ReaderSignalCollectService.LOCK_NAME))
      return null;
    try {
      return await this.collect();
    } finally {
      this.lock.release(ReaderSignalCollectService.LOCK_NAME);
    }
  }

  private async collect(): Promise<ReaderSignalOutcome> {
    const outcome = emptyOutcome(this.budget);
    const budget = new ReaderSignalRunBudget(
      this.budget,
      this.maxFailures,
      this.delayMs,
      (ms) => this.sleep(ms),
    );

    /**
     * Identifiants MU BRUTS des lecteurs vus cette nuit, associés à leur
     * hash. Vit uniquement ici, le temps du run — jamais persisté, jamais
     * loggé, hors de portée de toute autre couche.
     */
    const seen = new Map<string, string>();

    await this.runDiscovery(outcome, budget, seen);
    await this.runExtraction(outcome, budget, seen);

    seen.clear();
    outcome.requestsUsed = budget.used;
    outcome.circuitBroken = budget.circuitBroken;
    this.report(outcome);
    return outcome;
  }

  // ───────────────────────────── Découverte ─────────────────────────────

  private async runDiscovery(
    outcome: ReaderSignalOutcome,
    budget: ReaderSignalRunBudget,
    seen: Map<string, string>,
  ): Promise<void> {
    const discoveryBudget = Math.floor(this.budget * this.discoveryShare);
    const seriesBudget = Math.floor(discoveryBudget / READER_LIST_TYPES.length);
    const { targets, cursors } = await this.priority.buildQueue(
      seriesBudget,
      this.typeDepth,
      NSFW_GENRES,
    );

    const consumedByBucket: Record<string, number> = {};
    for (const target of targets) {
      if (!budget.canContinue || budget.used >= discoveryBudget) break;
      if (!(await this.probeSeries(target, outcome, budget, seen))) break;
      consumedByBucket[target.bucket] =
        (consumedByBucket[target.bucket] ?? 0) + 1;
    }

    for (const cursor of cursors) {
      await this.priority.advanceCursor(
        cursor,
        consumedByBucket[cursor.bucket] ?? 0,
      );
    }
    outcome.readersDiscovered = seen.size;
  }

  /**
   * Sonde une série sur les cinq types de liste et persiste immédiatement le
   * signal obtenu. Retourne `false` si le run doit s'arrêter.
   *
   * Les cinq types sont bien nécessaires : sur une série en cours, `read`
   * sature à 100 lecteurs là où `complete` s'effondre (mesuré sur Nano
   * Machine : `complete=4`, `read=100`). Et `unfinished` / `hold` sont la
   * seule source du signal négatif qui manque au produit.
   */
  private async probeSeries(
    target: DiscoveryTarget,
    outcome: ReaderSignalOutcome,
    budget: ReaderSignalRunBudget,
    seen: Map<string, string>,
  ): Promise<boolean> {
    const known = new Map<string, string | null>([
      [target.muId, target.mangaType],
    ]);
    for (const listType of READER_LIST_TYPES) {
      if (!budget.canContinue) return false;
      let readers;
      try {
        readers = await budget.spend(() =>
          this.client.fetchSimilarReaders(listType, target.muId),
        );
      } catch (err) {
        budget.recordFailure();
        this.logger.warn(
          `[reader-signal] découverte ${listType}/${target.muId} en échec : ` +
            `${(err as Error)?.message ?? err}`,
        );
        continue;
      }
      budget.recordSuccess();
      outcome.discoveryProbes += 1;
      outcome.probesByBucket[target.bucket] =
        (outcome.probesByBucket[target.bucket] ?? 0) + 1;
      if (readers.length === 0) continue;

      // Hachage AVANT toute écriture et avant toute lecture en base.
      const rows: PersistableSignalRow[] = [];
      for (const reader of readers) {
        const userHash =
          seen.get(reader.userId) ?? this.hasher.hash(reader.userId);
        seen.set(reader.userId, userHash);
        rows.push({
          userHash,
          muId: target.muId,
          listType,
          rating: reader.rating,
        });
      }
      accumulate(outcome, await this.writer.writeSignal(rows, known));
    }
    return true;
  }

  // ───────────────────────────── Extraction ─────────────────────────────

  /**
   * Extrait les lecteurs découverts qui ne l'ont pas été récemment.
   *
   * La fenêtre de fraîcheur est indispensable : `/lists/similar` renvoie
   * toujours les 100 `user_id` les plus anciens d'une série, donc la
   * découverte re-propose massivement des lecteurs déjà vus. Sans ce filtre,
   * le job dépenserait chaque nuit son budget sur les mêmes comptes. Leur
   * signal de découverte est tout de même écrit : il est déjà payé.
   */
  private async runExtraction(
    outcome: ReaderSignalOutcome,
    budget: ReaderSignalRunBudget,
    seen: Map<string, string>,
  ): Promise<void> {
    if (!budget.canContinue || seen.size === 0) return;

    const fresh = await this.writer.findFreshReaders(
      [...seen.values()],
      this.readerTtlDays,
      this.readerMaxFailures,
    );
    for (const [userId, userHash] of seen) {
      if (!budget.canContinue) break;
      if (fresh.has(userHash)) {
        outcome.readersSkippedFresh += 1;
        continue;
      }
      await this.extraction.extractReader(userId, userHash, outcome, budget);
    }
  }

  /** Bilan de run, sans aucune donnée personnelle. */
  private report(outcome: ReaderSignalOutcome): void {
    const ratingShare =
      outcome.rowsWritten > 0
        ? Math.round((outcome.rowsWithRating / outcome.rowsWritten) * 100)
        : 0;
    const byType = Object.entries(outcome.rowsByMangaType)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type}=${count}`)
      .join(' ');
    this.logger.log(
      `[reader-signal] ${outcome.requestsUsed}/${outcome.budget} requête(s) | ` +
        `découverte ${outcome.discoveryProbes} sonde(s) ` +
        `(${formatCounts(outcome.probesByBucket)}) | ` +
        `lecteurs vus ${outcome.readersDiscovered}, extraits ` +
        `${outcome.readersExtracted}, sans liste ${outcome.readersEmpty}, ` +
        `frais ignorés ${outcome.readersSkippedFresh}, échecs ` +
        `${outcome.readersFailed} | lignes ${outcome.rowsWritten} ` +
        `(${ratingShare} % notées, ${outcome.rowsUnknownSeries} hors ` +
        `catalogue) | par type : ${byType || 'aucune'}` +
        (outcome.circuitBroken ? ' | DISJONCTEUR déclenché' : ''),
    );
  }
}
