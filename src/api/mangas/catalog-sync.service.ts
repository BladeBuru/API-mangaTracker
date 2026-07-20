import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';
import {
  CatalogSyncJobName,
  CatalogSyncState,
} from './catalog-sync-state.entity';
import {
  buildCatalogUpsertRows,
  CatalogPage,
  intFromConfig,
  MuSearchBody,
  MuSearchResult,
} from './catalog-sync.mapper';
import { MU_TRENDS_URL, NSFW_GENRES } from './constants';
import { Manga } from './manga.entity';
import { MangasService } from './mangas.service';

/**
 * Synchronisation nightly du catalogue MangaUpdates vers la table `manga`
 * (design catalogue-recos, étape 2) : constitue un catalogue local (~5000
 * titres par rating + top hebdo) pour que `CatalogCandidateService` puisse
 * élargir les recommandations sans appel MU à chaud.
 *
 * Politique réseau (MU ≈ 60 req/min anonyme) : 1 requête /
 * `CATALOG_SYNC_DELAY_MS` (2000 ms = 30 req/min = 50 % du plafond), cron
 * 03:30 + jitter 0-15 min, backoff 5/10/20/40 s sur 429/5xx. Échec
 * persistant → arrêt PROPRE : curseur persisté, statut `partial`,
 * `consecutive_failures++` — jamais avalé.
 *
 * Anti-réentrance : flag `running` in-process (1 seul process API en prod).
 * Si l'API passe multi-instance, remplacer par un `pg_advisory_lock`.
 */
@Injectable()
export class CatalogSyncService {
  private readonly logger = new Logger(CatalogSyncService.name);

  /** perpage max accepté par MU (au-delà, coercion silencieuse). */
  private static readonly PER_PAGE = 100;

  /** Page max acceptée par MU (au-delà : 400 Bad Request). */
  private static readonly MU_PAGE_HARD_CAP = 400;

  /** Pages de la passe hebdo `week_pos` (dimanche). */
  private static readonly WEEKLY_PAGES = 10;

  /** Jitter max avant le run nightly (15 min). */
  private static readonly JITTER_MAX_MS = 15 * 60 * 1000;

  /** Backoff sur 429/5xx (4 tentatives après l'appel initial). */
  private static readonly BACKOFF_DELAYS_MS = [5_000, 10_000, 20_000, 40_000];

  private readonly enabled: boolean;
  private readonly maxPages: number;
  private readonly pagesPerRun: number;
  private readonly delayMs: number;
  private readonly hydrationBudget: number;

  /** Anti-réentrance in-process (voir doc de classe). */
  private running = false;

  /** Warn une seule fois si le payload search ne contient pas les genres. */
  private genresMissingWarned = false;

  /** Injectable pour les tests (évite les vrais timers). */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(CatalogSyncState)
    private readonly stateRepository: Repository<CatalogSyncState>,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    private readonly mangasService: MangasService,
    config: ConfigService,
  ) {
    const enabledRaw = config.get<string>('CATALOG_SYNC_ENABLED');
    // Défaut : activé, sauf en environnement de test.
    this.enabled =
      enabledRaw !== undefined && enabledRaw !== ''
        ? enabledRaw === 'true'
        : config.get<string>('NODE_ENV') !== 'test';
    this.maxPages = intFromConfig(config, 'CATALOG_SYNC_MAX_PAGES', 50);
    this.pagesPerRun = intFromConfig(config, 'CATALOG_SYNC_PAGES_PER_RUN', 60);
    this.delayMs = intFromConfig(config, 'CATALOG_SYNC_DELAY_MS', 2000);
    this.hydrationBudget = intFromConfig(
      config,
      'CATALOG_SYNC_HYDRATION_BUDGET',
      200,
    );
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
   * Point d'entrée testable. Sans argument : passe `rating`, puis passe
   * hebdo `week_pos` le dimanche, puis hydratation des genres manquants.
   * Avec `jobName` : ce job uniquement. No-op (warn) si un run est déjà en
   * cours (anti-réentrance).
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
      const weekly: [CatalogSyncJobName, string, number] = [
        'catalog:week_pos',
        'week_pos',
        CatalogSyncService.WEEKLY_PAGES,
      ];
      if (jobName === 'catalog:rating') {
        await this.runCatalogPass('catalog:rating', 'rating', this.maxPages);
      } else if (jobName === 'catalog:week_pos') {
        await this.runCatalogPass(...weekly);
      } else if (jobName === 'hydration') {
        await this.hydrateMissingGenres();
      } else {
        await this.runCatalogPass('catalog:rating', 'rating', this.maxPages);
        if (new Date().getDay() === 0) await this.runCatalogPass(...weekly);
        await this.hydrateMissingGenres();
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Une passe de catalogue : reprend au curseur persisté, ingère au plus
   * `CATALOG_SYNC_PAGES_PER_RUN` pages (curseur persisté page par page).
   * Dernière page atteinte → curseur remis à 0, statut `completed`.
   */
  private async runCatalogPass(
    jobName: CatalogSyncJobName,
    orderby: string,
    pagesCap: number,
  ): Promise<void> {
    const state = await this.getOrCreateState(jobName);
    let page = state.last_completed_page;
    let totalPages = state.total_pages;
    let pagesFetched = 0;

    while (pagesFetched < this.pagesPerRun) {
      if (page >= this.effectiveLastPage(totalPages, pagesCap)) break;
      const nextPage = page + 1;

      let result: CatalogPage;
      try {
        result = await this.fetchPageWithBackoff(orderby, nextPage);
      } catch (err) {
        // Backoff épuisé ou erreur non-retryable : arrêt PROPRE.
        state.last_completed_page = page;
        state.total_pages = totalPages;
        state.last_run_at = new Date();
        state.last_run_status = 'partial';
        state.consecutive_failures += 1;
        await this.stateRepository.save(state);
        this.logger.warn(
          `[${jobName}] arrêt partiel sur la page ${nextPage} : ${
            (err as Error)?.message ?? err
          } — reprise à la page ${page + 1} au prochain run`,
        );
        return;
      }

      await this.upsertPage(result.records);
      pagesFetched += 1;
      page = nextPage;
      totalPages = Math.max(
        1,
        Math.ceil(result.totalHits / CatalogSyncService.PER_PAGE),
      );
      state.last_completed_page = page;
      state.total_pages = totalPages;
      await this.stateRepository.save(state);

      // 1 requête / delayMs (30 req/min à 2000 ms = 50 % du plafond MU).
      await this.sleep(this.delayMs);
    }

    const done = page >= this.effectiveLastPage(totalPages, pagesCap);
    state.last_completed_page = done ? 0 : page;
    state.total_pages = totalPages;
    state.last_run_at = new Date();
    state.last_run_status = done ? 'completed' : 'partial';
    if (done) state.consecutive_failures = 0;
    await this.stateRepository.save(state);
    this.logger.log(
      `[${jobName}] ${pagesFetched} page(s) ingérée(s) — ${
        done
          ? 'passe complétée (curseur remis à 0)'
          : `budget épuisé, reprise à la page ${page + 1}`
      }`,
    );
  }

  /** Dernière page de la passe : min(total_pages, cap job, cap MU 400). */
  private effectiveLastPage(
    totalPages: number | null,
    pagesCap: number,
  ): number {
    const cap = Math.min(pagesCap, CatalogSyncService.MU_PAGE_HARD_CAP);
    return totalPages === null ? cap : Math.min(totalPages, cap);
  }

  /** POST MU /series/search — une page du catalogue (perpage 100). */
  async fetchSearchPage(orderby: string, page: number): Promise<CatalogPage> {
    const payload = {
      orderby,
      perpage: CatalogSyncService.PER_PAGE,
      page,
      exclude_genre: NSFW_GENRES,
    };
    const { data } = await firstValueFrom(
      this.httpService.post<MuSearchBody>(MU_TRENDS_URL, payload),
    );
    const records = data?.results ?? [];
    const totalHits = Number(data?.total_hits ?? records.length) || 0;
    return { records, totalHits };
  }

  /**
   * fetchSearchPage avec backoff 5/10/20/40 s sur 429/5xx. Toute autre
   * erreur est rethrow immédiatement — le caller fait l'arrêt propre.
   */
  private async fetchPageWithBackoff(
    orderby: string,
    page: number,
  ): Promise<CatalogPage> {
    let lastError: unknown;
    const retries = CatalogSyncService.BACKOFF_DELAYS_MS;
    for (let attempt = 0; attempt <= retries.length; attempt++) {
      if (attempt > 0) {
        const delay = retries[attempt - 1];
        this.logger.warn(
          `MU ${orderby} page ${page} : retry ${attempt}/${retries.length} dans ${delay} ms`,
        );
        await this.sleep(delay);
      }
      try {
        return await this.fetchSearchPage(orderby, page);
      } catch (err) {
        lastError = err;
        const status = (err as AxiosError)?.response?.status;
        const retryable =
          status === 429 || (typeof status === 'number' && status >= 500);
        if (!retryable) throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Upsert d'une page en DEUX lots pour ne JAMAIS écraser des genres
   * existants par null : le lot « sans genres » omet la colonne `genres`
   * du `orUpdate`. `total_chapters` / `completed` / `associated` ne sont
   * jamais listés → intouchés (préserve GREATEST et les données détail).
   */
  private async upsertPage(records: MuSearchResult[]): Promise<void> {
    const { withGenres, withoutGenres } = buildCatalogUpsertRows(records);

    if (
      records.length > 0 &&
      withGenres.length === 0 &&
      !this.genresMissingWarned
    ) {
      this.genresMissingWarned = true;
      this.logger.warn(
        'Payload search MU sans `record.genres` — hydratation différée via hydrateMissingGenres/getMangaDetails',
      );
    }

    const baseColumns = [
      'title',
      'year',
      'rating',
      'small_cover_url',
      'medium_cover_url',
    ];
    if (withGenres.length > 0) {
      await this.mangaRepository
        .createQueryBuilder()
        .insert()
        .into(Manga)
        .values(withGenres)
        .orUpdate([...baseColumns, 'genres'], ['mu_id'])
        .execute();
    }
    if (withoutGenres.length > 0) {
      await this.mangaRepository
        .createQueryBuilder()
        .insert()
        .into(Manga)
        .values(withoutGenres)
        .orUpdate(baseColumns, ['mu_id'])
        .execute();
    }
  }

  /**
   * Hydrate les mangas sans genres (catalogue ingéré sans `record.genres`
   * + stubs de `saveRecommendations`) via `getMangaDetails` (UPDATE
   * complet), les mieux notés d'abord, au rythme d'1 appel / delayMs.
   * @returns nombre de mangas hydratés avec succès.
   */
  async hydrateMissingGenres(
    budget: number = this.hydrationBudget,
  ): Promise<number> {
    const stubs = await this.mangaRepository
      .createQueryBuilder('m')
      .where('m.genres IS NULL')
      .orderBy('m.rating', 'DESC', 'NULLS LAST')
      .limit(budget)
      .getMany();
    if (stubs.length === 0) return 0;

    let hydrated = 0;
    for (const manga of stubs) {
      try {
        await this.mangasService.getMangaDetails(Number(manga.mu_id));
        hydrated += 1;
      } catch (err) {
        this.logger.warn(
          `Hydratation genres mu_id=${manga.mu_id} en échec : ${
            (err as Error)?.message ?? err
          }`,
        );
      }
      await this.sleep(this.delayMs);
    }

    const state = await this.getOrCreateState('hydration');
    state.last_run_at = new Date();
    state.last_run_status = 'completed';
    await this.stateRepository.save(state);
    this.logger.log(
      `Hydratation genres : ${hydrated}/${stubs.length} manga(s) complétés`,
    );
    return hydrated;
  }

  private async getOrCreateState(
    jobName: CatalogSyncJobName,
  ): Promise<CatalogSyncState> {
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
    });
  }
}
