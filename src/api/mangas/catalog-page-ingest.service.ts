import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';
import { buildSearchBody, CatalogShard } from './catalog-shard';
import {
  buildCatalogUpsertBatches,
  CatalogPage,
  MuSearchBody,
  MuSearchResult,
} from './catalog-sync.mapper';
import { MU_TRENDS_URL } from './constants';
import { Manga } from './manga.entity';

/**
 * Ingestion d'UNE page de catalogue : appel MU `/series/search` avec backoff,
 * puis upsert des records dans `manga`. Extrait de `CatalogSyncService`
 * (2026-08-28) pour tenir la limite de 400 lignes du repo — le service de
 * synchronisation garde l'orchestration (file de shards, budget, curseur),
 * celui-ci la mécanique d'une page.
 *
 * Toute erreur remonte au caller : c'est lui qui décide de l'arrêt propre
 * (curseur conservé, statut `partial`).
 */
@Injectable()
export class CatalogPageIngestService {
  private readonly logger = new Logger(CatalogPageIngestService.name);

  /** perpage max accepté par MU (au-delà, coercion silencieuse). */
  static readonly PER_PAGE = 100;

  /** Backoff sur 429/5xx (4 tentatives après l'appel initial). */
  private static readonly BACKOFF_DELAYS_MS = [5_000, 10_000, 20_000, 40_000];

  /** Warn une seule fois si le payload search ne contient pas les genres. */
  private genresMissingWarned = false;

  /** Injectable pour les tests (évite les vrais timers). */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
  ) {}

  /**
   * Récupère la page (avec backoff) et l'upserte.
   *
   * @returns le `total_hits` annoncé par MU pour ce shard — le caller en
   *          déduit le nombre réel de pages et l'éventuelle saturation.
   */
  async ingestPage(shard: CatalogShard, page: number): Promise<number> {
    const result = await this.fetchPageWithBackoff(shard, page);
    await this.upsertPage(result.records);
    return result.totalHits;
  }

  /** POST MU /series/search — une page d'un shard (perpage 100). */
  async fetchSearchPage(
    shard: CatalogShard,
    page: number,
  ): Promise<CatalogPage> {
    const payload = buildSearchBody(
      shard,
      page,
      CatalogPageIngestService.PER_PAGE,
    );
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
    shard: CatalogShard,
    page: number,
  ): Promise<CatalogPage> {
    let lastError: unknown;
    const retries = CatalogPageIngestService.BACKOFF_DELAYS_MS;
    for (let attempt = 0; attempt <= retries.length; attempt++) {
      if (attempt > 0) {
        const delay = retries[attempt - 1];
        this.logger.warn(
          `MU ${shard.jobName} page ${page} : retry ${attempt}/${retries.length} dans ${delay} ms`,
        );
        await this.sleep(delay);
      }
      try {
        return await this.fetchSearchPage(shard, page);
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
   * Upsert d'une page en lots regroupés par colonnes NON-NULL : chaque lot ne
   * liste dans son `orUpdate` que les colonnes réellement renseignées, donc
   * une colonne absente du payload MU (rating/year/covers/genres) n'écrase
   * JAMAIS la valeur existante par null (préserve l'hydratation détail).
   * `total_chapters` / `completed` / `associated` ne sont jamais listés →
   * intouchés (préserve GREATEST et les données détail).
   *
   * `associated` en particulier n'est PAS alimentable ici : le payload
   * `/series/search` ne contient pas ce champ (vérifié le 2026-08-28 — voir
   * `docs/specs/mangas/spec-technique.md`).
   */
  private async upsertPage(records: MuSearchResult[]): Promise<void> {
    const batches = buildCatalogUpsertBatches(records);

    const hasAnyGenres = batches.some((b) => b.overwrite.includes('genres'));
    if (records.length > 0 && !hasAnyGenres && !this.genresMissingWarned) {
      this.genresMissingWarned = true;
      this.logger.warn(
        'Payload search MU sans `record.genres` — hydratation différée via hydrateIncompleteRows/getMangaDetails',
      );
    }

    for (const batch of batches) {
      if (batch.rows.length === 0) continue;
      await this.mangaRepository
        .createQueryBuilder()
        .insert()
        .into(Manga)
        .values(batch.rows)
        .orUpdate(batch.overwrite, ['mu_id'])
        .execute();
    }
  }
}
