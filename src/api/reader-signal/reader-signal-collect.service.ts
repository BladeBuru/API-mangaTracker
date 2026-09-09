import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { intFromConfig } from '@/api/mangas/catalog-sync.mapper';
import { NSFW_GENRES } from '@/api/mangas/constants';
import { MuJobLockService } from '@/api/mangas/mu-job-lock.service';
import { MU_LIST_MAX_PER_PAGE, MuListsClient } from './mu-lists.client';
import { pagesNeeded, RawSignalRow } from './mu-lists.mapper';
import { ReaderHashService } from './reader-hash.service';
import {
  DiscoveryTarget,
  ReaderSignalPriorityService,
} from './reader-signal-priority.service';
import {
  PersistableSignalRow,
  ReaderSignalWriterService,
  WriteOutcome,
} from './reader-signal-writer.service';
import { READER_LIST_TYPES } from './reader-signal-weights';

/** Bilan d'un run — c'est ce que les logs et les tests observent. */
export interface ReaderSignalOutcome {
  /** Requêtes `/lists/similar` envoyées. */
  discoveryProbes: number;
  /** Sondes par seau de priorité (`library`, `Manhwa`, `Manhua`, `Manga`). */
  probesByBucket: Record<string, number>;
  /** Lecteurs distincts vus par la découverte. */
  readersDiscovered: number;
  /** … écartés parce que déjà collectés dans la fenêtre de fraîcheur. */
  readersSkippedFresh: number;
  /** … effectivement extraits (au moins une liste publique lue). */
  readersExtracted: number;
  /** … sans aucune liste publique. */
  readersEmpty: number;
  /** … dont l'extraction a échoué côté MU. */
  readersFailed: number;
  rowsWritten: number;
  rowsWithRating: number;
  /** Lignes écartées : série absente du catalogue. */
  rowsUnknownSeries: number;
  /** Ventilation des lignes écrites par `manga.type`. */
  rowsByMangaType: Record<string, number>;
  requestsUsed: number;
  budget: number;
  circuitBroken: boolean;
}

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
 * 1. **Découverte** — `GET /lists/similar/{type}/{mu_id}` sur les séries
 *    prioritaires (`ReaderSignalPriorityService`). Chaque réponse est déjà
 *    du signal exploitable : elle donne, pour la série sondée, jusqu'à 100
 *    lecteurs avec leur note. Une requête de découverte n'est donc jamais
 *    « perdue », même si l'extraction ne suit pas.
 * 2. **Extraction** — pour les lecteurs découverts et non encore collectés :
 *    `GET /lists/public/{uid}` puis une requête par liste publique
 *    (`perpage` à 1000, une seule page suffit presque toujours).
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
  private readonly maxListPages: number;
  private readonly perPage: number;
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
    // 0,4 : la découverte rapporte ~70 lignes/requête et alimente le vivier
    // de lecteurs ; l'extraction ~90 lignes/requête mais élargit le vecteur
    // de chaque lecteur, sans quoi il n'y a pas de co-occurrence. Les deux
    // sont nécessaires, la découverte est prioritaire au démarrage.
    this.discoveryShare =
      Number.isFinite(share) && share > 0 && share < 1 ? share : 0.4;
    this.typeDepth = intFromConfig(config, 'READER_SIGNAL_TYPE_DEPTH', 1500);
    this.readerTtlDays = intFromConfig(
      config,
      'READER_SIGNAL_READER_TTL_DAYS',
      30,
    );
    this.maxListPages = intFromConfig(
      config,
      'READER_SIGNAL_MAX_LIST_PAGES',
      3,
    );
    this.perPage = Math.min(
      intFromConfig(config, 'READER_SIGNAL_PER_PAGE', MU_LIST_MAX_PER_PAGE),
      MU_LIST_MAX_PER_PAGE,
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
   * Point d'entrée testable. `null` si le job est désactivé, si le sel de
   * pseudonymisation manque, ou si un autre job MU tient le verrou.
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
    const state = new RunState(this.budget, this.maxFailures);

    /**
     * Identifiants MU BRUTS des lecteurs vus cette nuit, associés à leur
     * hash. Vit uniquement ici, le temps du run — jamais persisté, jamais
     * loggé, hors de portée de toute autre couche.
     */
    const seen = new Map<string, string>();

    await this.runDiscovery(outcome, state, seen);
    await this.runExtraction(outcome, state, seen);

    seen.clear();
    outcome.requestsUsed = state.used;
    outcome.circuitBroken = state.circuitBroken;
    this.report(outcome);
    return outcome;
  }

  // ───────────────────────────── Découverte ─────────────────────────────

  private async runDiscovery(
    outcome: ReaderSignalOutcome,
    state: RunState,
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
      if (state.circuitBroken || state.remaining <= 0) break;
      if (state.used >= discoveryBudget) break;
      const done = await this.probeSeries(target, outcome, state, seen);
      if (!done) break;
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
   */
  private async probeSeries(
    target: DiscoveryTarget,
    outcome: ReaderSignalOutcome,
    state: RunState,
    seen: Map<string, string>,
  ): Promise<boolean> {
    const known = new Map<string, string | null>([
      [target.muId, target.mangaType],
    ]);
    for (const listType of READER_LIST_TYPES) {
      if (state.remaining <= 0 || state.circuitBroken) return false;
      let readers;
      try {
        readers = await this.spend(state, () =>
          this.client.fetchSimilarReaders(listType, target.muId),
        );
      } catch (err) {
        state.recordFailure();
        this.logger.warn(
          `[reader-signal] découverte ${listType}/${target.muId} en échec : ` +
            `${(err as Error)?.message ?? err}`,
        );
        continue;
      }
      state.recordSuccess();
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

  private async runExtraction(
    outcome: ReaderSignalOutcome,
    state: RunState,
    seen: Map<string, string>,
  ): Promise<void> {
    if (state.remaining <= 0 || state.circuitBroken || seen.size === 0) return;

    const fresh = await this.writer.findFreshReaders(
      [...seen.values()],
      this.readerTtlDays,
      this.readerMaxFailures,
    );
    for (const [userId, userHash] of seen) {
      if (state.remaining <= 0 || state.circuitBroken) break;
      if (fresh.has(userHash)) {
        outcome.readersSkippedFresh += 1;
        continue;
      }
      await this.extractReader(userId, userHash, outcome, state);
    }
  }

  /** Lit les listes publiques d'un lecteur et persiste leur contenu. */
  private async extractReader(
    userId: string,
    userHash: string,
    outcome: ReaderSignalOutcome,
    state: RunState,
  ): Promise<void> {
    let lists;
    try {
      lists = await this.spend(state, () =>
        this.client.fetchPublicLists(userId),
      );
    } catch (err) {
      state.recordFailure();
      // Aucun identifiant dans le message : ni `userId`, ni `userHash`.
      this.logger.warn(
        `[reader-signal] listes publiques illisibles : ${
          (err as Error)?.message ?? err
        }`,
      );
      await this.writer.recordProfile(userHash, 'failed', 0, 0);
      outcome.readersFailed += 1;
      return;
    }
    state.recordSuccess();
    if (lists.length === 0) {
      await this.writer.recordProfile(userHash, 'empty', 0, 0);
      outcome.readersEmpty += 1;
      return;
    }

    const collected: RawSignalRow[] = [];
    let failed = false;
    for (const list of lists) {
      if (state.remaining <= 0 || state.circuitBroken) break;
      try {
        collected.push(...(await this.readList(userId, list, state)));
      } catch (err) {
        failed = true;
        state.recordFailure();
        this.logger.warn(
          `[reader-signal] liste ${list.listType} illisible : ${
            (err as Error)?.message ?? err
          }`,
        );
        break;
      }
      state.recordSuccess();
    }

    const known = await this.writer.knownSeries(collected.map((r) => r.muId));
    const written = await this.writer.writeSignal(
      collected.map((row) => ({ userHash, ...row })),
      known,
    );
    accumulate(outcome, written);
    if (failed && written.written === 0) {
      await this.writer.recordProfile(userHash, 'failed', lists.length, 0);
      outcome.readersFailed += 1;
      return;
    }
    await this.writer.recordProfile(
      userHash,
      'collected',
      lists.length,
      written.written,
    );
    outcome.readersExtracted += 1;
  }

  /** Toutes les pages d'une liste publique, dans la limite du budget. */
  private async readList(
    userId: string,
    list: { listId: string; listType: RawListType },
    state: RunState,
  ): Promise<RawSignalRow[]> {
    const first = await this.spend(state, () =>
      this.client.fetchListPage(
        userId,
        list.listId,
        list.listType,
        1,
        this.perPage,
      ),
    );
    const rows = [...first.rows];
    // `per_page` renvoyé ≠ demandé ⇒ MU a coercé (mesuré : > 1000 → 25).
    const effective = first.perPageEcho > 0 ? first.perPageEcho : this.perPage;
    const pages = pagesNeeded(first.totalHits, effective, this.maxListPages);
    for (let page = 2; page <= pages; page++) {
      if (state.remaining <= 0) break;
      const next = await this.spend(state, () =>
        this.client.fetchListPage(
          userId,
          list.listId,
          list.listType,
          page,
          this.perPage,
        ),
      );
      rows.push(...next.rows);
    }
    return rows;
  }

  // ─────────────────────────────── Plomberie ────────────────────────────

  /**
   * Décompte une requête du budget, respecte la cadence MU, puis exécute.
   *
   * Le délai est appliqué AVANT l'appel et non après : un run interrompu en
   * plein milieu (redémarrage, disjoncteur) ne laisse alors jamais deux
   * requêtes séparées de moins de `delayMs`, même à cheval sur deux runs.
   */
  private async spend<T>(state: RunState, call: () => Promise<T>): Promise<T> {
    if (state.used > 0) await this.sleep(this.delayMs);
    state.used += 1;
    return call();
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

/** Type de liste, ré-exporté localement pour alléger la signature. */
type RawListType = RawSignalRow['listType'];

/**
 * Budget, disjoncteur et compteur de requêtes d'un run.
 *
 * Le disjoncteur compte les échecs CONSÉCUTIFS (remis à 0 par tout succès) :
 * MU qui répond mal ponctuellement ne doit pas arrêter la nuit, MU qui ne
 * répond plus du tout doit l'arrêter immédiatement plutôt que de consommer
 * 1 000 requêtes en pure perte — et de ressembler à une attaque.
 */
class RunState {
  used = 0;
  circuitBroken = false;
  private consecutiveFailures = 0;

  constructor(
    private readonly budget: number,
    private readonly maxFailures: number,
  ) {}

  get remaining(): number {
    return this.budget - this.used;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxFailures) this.circuitBroken = true;
  }
}

function emptyOutcome(budget: number): ReaderSignalOutcome {
  return {
    discoveryProbes: 0,
    probesByBucket: {},
    readersDiscovered: 0,
    readersSkippedFresh: 0,
    readersExtracted: 0,
    readersEmpty: 0,
    readersFailed: 0,
    rowsWritten: 0,
    rowsWithRating: 0,
    rowsUnknownSeries: 0,
    rowsByMangaType: {},
    requestsUsed: 0,
    budget,
    circuitBroken: false,
  };
}

function accumulate(outcome: ReaderSignalOutcome, written: WriteOutcome): void {
  outcome.rowsWritten += written.written;
  outcome.rowsWithRating += written.withRating;
  outcome.rowsUnknownSeries += written.unknownSeries;
  for (const [type, count] of Object.entries(written.byMangaType)) {
    outcome.rowsByMangaType[type] =
      (outcome.rowsByMangaType[type] ?? 0) + count;
  }
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return 'aucune';
  return entries.map(([key, value]) => `${key}=${value}`).join(' ');
}
