import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogShardRunnerService } from './catalog-shard-runner.service';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { intFromConfig } from './catalog-sync.mapper';
import {
  parseBackfillTypes,
  planTypeBackfillQueue,
} from './catalog-type-backfill.planner';
import { TYPE_BACKFILL_DEFAULT_TYPES } from './manga-type';
import { Manga } from './manga.entity';
import { MangasService } from './mangas.service';
import { MuJobLockService } from './mu-job-lock.service';

/** Bilan d'un run, pour les logs et les tests. */
export interface TypeBackfillOutcome {
  /** Fiches `/series/{id}` demandées pour les titres en bibliothèque. */
  libraryAttempted: number;
  /** … dont réussies (type écrit si MU le fournit). */
  libraryHydrated: number;
  /** Pages `/series/search` ingérées sur les shards type × année. */
  pagesFetched: number;
  /** Shards touchés pendant ce run. */
  shardsTouched: number;
  /** Run interrompu par le disjoncteur (3 shards consécutifs en échec). */
  circuitBroken: boolean;
}

/**
 * Rattrapage de la colonne `manga.type` (2026-09-05), en deux volets qui
 * partagent la cadence MU (1 req / `CATALOG_SYNC_DELAY_MS`) et le verrou
 * `MuJobLockService` (jamais deux jobs MU en parallèle).
 *
 * ## Volet A — bibliothèques, immédiat
 *
 * Au démarrage du process (puis en tête de chaque run nocturne) : chaque
 * titre présent dans AU MOINS une bibliothèque (`user_manga`) et dont le
 * type est inconnu est relu via `GET /series/{id}` (`getMangaDetails`, qui
 * persiste `type` par la doctrine null-safe). ~80 titres en prod → ~3 min.
 * C'est ce qui rend le profil de type des utilisateurs exact dès le premier
 * démarrage, sans attendre le catalogue.
 *
 * ## Volet B — catalogue, nocturne (cron 01:00 + jitter 0-10 min)
 *
 * Pour chaque année (courante → `CATALOG_TYPE_BACKFILL_YEAR_FLOOR`, 1950),
 * une recherche `/series/search` filtrée `type: ['Manhwa']` puis
 * `['Manhua']` (pages de 100, curseur persistant dans `catalog_sync_state`
 * sous `type:<T>:year:<AAAA>`). L'upsert est celui du catalogue : un titre
 * déjà en base reçoit son `type`, un titre absent est ingéré normalement.
 * Budget `CATALOG_TYPE_BACKFILL_PAGES_PER_RUN` (200 pages ≈ 7 min), même
 * backoff que le catalogue, disjoncteur après 3 shards consécutifs en échec.
 *
 * ## Pourquoi PAS de valeur par défaut « Manga » pour les lignes NULL
 *
 * Le payload `/series/search` contient `record.type` pour TOUTES les séries
 * (vérifié le 2026-09-05), et le mapper catalogue le persiste désormais. Le
 * catalogue nightly ordinaire remplit donc la colonne avec la VRAIE valeur
 * (Manga, mais aussi Novel, OEL, Doujinshi…) sur chaque ligne revisitée —
 * au plus tard à la prochaine fenêtre de rafraîchissement du shard annuel
 * (7 j pour les deux dernières années, 30 j sinon). Marquer « Manga » par
 * défaut fabriquerait une donnée fausse pour les novels/OEL et masquerait
 * l'information « inconnu » que les recommandations savent traiter (type
 * NULL autorisé mais pénalisé). Le rattrapage dédié ne sert qu'à accélérer
 * ce qui compte le plus pour les utilisateurs : manhwa et manhua.
 *
 * ## Créneau
 *
 * 01:00 : le job dure ~7 min (200 pages) + ~3 min de bibliothèques ; les
 * sorties tournent à 02:00 (+10 min de jitter), le catalogue à 03:30. Même à
 * budget quintuplé, aucun chevauchement — et le verrou partagé garantit
 * l'exclusion si un run déborde ou si un déploiement tombe pendant un job.
 */
@Injectable()
export class CatalogTypeBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogTypeBackfillService.name);

  /** Nom sous lequel ce job prend le verrou MU. */
  static readonly LOCK_NAME = 'type-backfill';

  /** Jitter max avant le run nocturne (10 min). */
  private static readonly JITTER_MAX_MS = 10 * 60 * 1000;

  /** Disjoncteur, aligné sur `CatalogSyncService`. */
  private static readonly MAX_CONSECUTIVE_SHARD_FAILURES = 3;

  private static readonly DEFAULT_PAGES_PER_RUN = 200;

  /** Mesuré : 1950 → 4 hits toutes catégories ; en dessous, rien. */
  private static readonly DEFAULT_YEAR_FLOOR = 1950;

  /** Plafond de fiches bibliothèque relues par run (garde-fou réseau). */
  private static readonly DEFAULT_LIBRARY_CAP = 500;

  /** Délai après le boot avant le volet A (laisse l'API finir de démarrer). */
  private static readonly BOOT_DELAY_MS = 60_000;

  /** Si un autre job MU tient le verrou au boot : réessai périodique. */
  private static readonly BOOT_RETRY_MS = 10 * 60_000;
  private static readonly BOOT_MAX_ATTEMPTS = 6;

  private readonly enabled: boolean;
  private readonly pagesPerRun: number;
  private readonly yearFloor: number;
  private readonly libraryCap: number;
  private readonly delayMs: number;
  private readonly types: string[];

  /** Injectable pour les tests (évite les vrais timers). */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @InjectRepository(CatalogSyncState)
    private readonly stateRepository: Repository<CatalogSyncState>,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    private readonly runner: CatalogShardRunnerService,
    private readonly mangasService: MangasService,
    private readonly lock: MuJobLockService,
    config: ConfigService,
  ) {
    const enabledRaw = config.get<string>('CATALOG_TYPE_BACKFILL_ENABLED');
    this.enabled =
      enabledRaw !== undefined && enabledRaw !== ''
        ? enabledRaw === 'true'
        : config.get<string>('NODE_ENV') !== 'test';
    this.pagesPerRun = intFromConfig(
      config,
      'CATALOG_TYPE_BACKFILL_PAGES_PER_RUN',
      CatalogTypeBackfillService.DEFAULT_PAGES_PER_RUN,
    );
    this.yearFloor = intFromConfig(
      config,
      'CATALOG_TYPE_BACKFILL_YEAR_FLOOR',
      CatalogTypeBackfillService.DEFAULT_YEAR_FLOOR,
    );
    this.libraryCap = intFromConfig(
      config,
      'CATALOG_TYPE_BACKFILL_LIBRARY_CAP',
      CatalogTypeBackfillService.DEFAULT_LIBRARY_CAP,
    );
    // Cadence MU partagée avec les autres jobs : une seule variable.
    this.delayMs = intFromConfig(config, 'CATALOG_SYNC_DELAY_MS', 2000);
    this.types = parseBackfillTypes(
      config.get<string>('CATALOG_TYPE_BACKFILL_TYPES'),
      TYPE_BACKFILL_DEFAULT_TYPES,
    );
  }

  /**
   * Volet A dès le démarrage : les recommandations doivent être correctes
   * tout de suite, pas après la prochaine nuit. Timer `unref` pour ne jamais
   * retenir le process (tests, arrêt propre).
   */
  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.scheduleBootBackfill(1, CatalogTypeBackfillService.BOOT_DELAY_MS);
  }

  private scheduleBootBackfill(attempt: number, delayMs: number): void {
    const timer = setTimeout(() => {
      this.runLibraryBackfillAtBoot(attempt).catch((err) =>
        this.logger.error(
          `Rattrapage type des bibliothèques (boot) en échec : ${
            (err as Error)?.message ?? err
          }`,
        ),
      );
    }, delayMs);
    timer.unref?.();
  }

  /** Volet A seul, sous verrou ; réessaie plus tard si un job MU tourne. */
  async runLibraryBackfillAtBoot(attempt = 1): Promise<void> {
    if (!this.lock.tryAcquire(CatalogTypeBackfillService.LOCK_NAME)) {
      if (attempt < CatalogTypeBackfillService.BOOT_MAX_ATTEMPTS) {
        this.scheduleBootBackfill(
          attempt + 1,
          CatalogTypeBackfillService.BOOT_RETRY_MS,
        );
      }
      return;
    }
    try {
      await this.backfillLibraryTypes();
    } finally {
      this.lock.release(CatalogTypeBackfillService.LOCK_NAME);
    }
  }

  /** Cron nocturne 01:00 (heure serveur) + jitter 0-10 min. */
  @Cron('0 0 1 * * *')
  async handleNightlyTypeBackfill(): Promise<void> {
    if (!this.enabled) return;
    const jitterMs = Math.floor(
      Math.random() * CatalogTypeBackfillService.JITTER_MAX_MS,
    );
    this.logger.log(
      `Rattrapage type dans ${Math.round(jitterMs / 1000)} s (jitter)`,
    );
    await this.sleep(jitterMs);
    await this.runOnce();
  }

  /**
   * Point d'entrée testable : volet A puis volet B, sous verrou MU. `null`
   * si un autre job MU est en cours (skip, jamais d'attente).
   */
  async runOnce(): Promise<TypeBackfillOutcome | null> {
    if (!this.lock.tryAcquire(CatalogTypeBackfillService.LOCK_NAME)) {
      return null;
    }
    try {
      const library = await this.backfillLibraryTypes();
      const shards = await this.runTypeShards();
      const outcome: TypeBackfillOutcome = { ...library, ...shards };
      this.logger.log(
        `[type-backfill] bibliothèques : ${outcome.libraryHydrated}/${outcome.libraryAttempted} ` +
          `fiche(s) ; catalogue : ${outcome.pagesFetched} page(s) sur ` +
          `${outcome.shardsTouched} shard(s)${
            outcome.circuitBroken ? ' — disjoncteur déclenché' : ''
          }`,
      );
      return outcome;
    } finally {
      this.lock.release(CatalogTypeBackfillService.LOCK_NAME);
    }
  }

  /**
   * Volet A : fiches `/series/{id}` des titres en bibliothèque dont le type
   * est inconnu, 1 req / `delayMs`. `getMangaDetails` persiste `type` (et
   * complète au passage genres/note/année/covers/titres alternatifs).
   *
   * Un titre pour lequel MU ne fournit pas de type reste NULL et sera relu
   * au prochain run : quelques requêtes par run au pire, le volet est borné
   * par `libraryCap` et ne concerne que des titres réellement suivis.
   */
  async backfillLibraryTypes(
    cap = this.libraryCap,
  ): Promise<
    Pick<TypeBackfillOutcome, 'libraryAttempted' | 'libraryHydrated'>
  > {
    const rows = await this.mangaRepository
      .createQueryBuilder('m')
      .select('m.mu_id', 'mu_id')
      .where('m.type IS NULL')
      .andWhere(
        'EXISTS (SELECT 1 FROM user_manga um WHERE um.manga_id = m.mu_id)',
      )
      .orderBy('m.id', 'ASC')
      .limit(cap)
      .getRawMany<{ mu_id: string }>();
    if (rows.length === 0) return { libraryAttempted: 0, libraryHydrated: 0 };

    this.logger.log(
      `[type-backfill] ${rows.length} titre(s) en bibliothèque sans type — relecture MU`,
    );
    let hydrated = 0;
    for (let i = 0; i < rows.length; i++) {
      const muId = Number(rows[i].mu_id);
      try {
        await this.mangasService.getMangaDetails(muId);
        hydrated += 1;
      } catch (err) {
        this.logger.warn(
          `[type-backfill] fiche mu_id=${muId} en échec : ${
            (err as Error)?.message ?? err
          }`,
        );
      }
      if (i < rows.length - 1) await this.sleep(this.delayMs);
    }
    return { libraryAttempted: rows.length, libraryHydrated: hydrated };
  }

  /**
   * Volet B : parcourt la file type × année en dépensant le budget de pages,
   * via le runner partagé avec le catalogue (curseur persisté page par page,
   * reprise inter-shards, statut partiel sur échec).
   */
  private async runTypeShards(): Promise<
    Pick<
      TypeBackfillOutcome,
      'pagesFetched' | 'shardsTouched' | 'circuitBroken'
    >
  > {
    const states = await this.stateRepository.find();
    const queue = planTypeBackfillQueue(
      states,
      this.types,
      new Date().getFullYear(),
      this.yearFloor,
    );
    if (queue.length === 0) {
      this.logger.log(
        '[type-backfill] tous les shards type × année sont terminés — rien à faire',
      );
      return { pagesFetched: 0, shardsTouched: 0, circuitBroken: false };
    }

    let remaining = this.pagesPerRun;
    let shardsTouched = 0;
    let consecutiveFailures = 0;
    for (let i = 0; i < queue.length && remaining > 0; i++) {
      const outcome = await this.runner.runShardPass(queue[i], remaining);
      remaining -= outcome.pagesFetched;
      if (outcome.pagesFetched > 0) shardsTouched += 1;
      consecutiveFailures = outcome.failed ? consecutiveFailures + 1 : 0;
      if (
        consecutiveFailures >=
        CatalogTypeBackfillService.MAX_CONSECUTIVE_SHARD_FAILURES
      ) {
        this.logger.error(
          `[type-backfill] ${consecutiveFailures} shards consécutifs en échec — ` +
            'run interrompu (MU probablement indisponible), curseurs conservés',
        );
        return {
          pagesFetched: this.pagesPerRun - remaining,
          shardsTouched,
          circuitBroken: true,
        };
      }
    }
    return {
      pagesFetched: this.pagesPerRun - remaining,
      shardsTouched,
      circuitBroken: false,
    };
  }
}
