import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { intFromConfig } from './catalog-sync.mapper';
import { Manga } from './manga.entity';
import { MangasService } from './mangas.service';

/**
 * Job nightly d'hydratation des lignes `manga` INCOMPLÈTES via
 * `getMangaDetails`, au rythme d'1 appel / `CATALOG_SYNC_DELAY_MS`.
 *
 * Extrait de `CatalogSyncService` (2026-08-28) avec le découpage du catalogue
 * par année : le service de synchronisation dépassait la limite de 400 lignes
 * du repo. Les deux jobs partagent la même contrainte de débit MU mais n'ont
 * rien d'autre en commun — l'un pagine une recherche, l'autre complète des
 * lignes une par une.
 *
 * **Critère élargi** (rationale complète : `docs/specs/mangas/spec-technique.md`) :
 *  - `genres`, `rating`, `year` OU `medium_cover_url` NULL — tout ce qui
 *    manque à une carte, plus seulement les genres ;
 *  - **priorisation par usage réel** : d'abord les `mu_id` présents dans
 *    `manga_recommendation`. L'ancien `ORDER BY rating DESC NULLS LAST` est
 *    supprimé : un stub a `rating` NULL par construction, il passait donc
 *    derrière les ~5000 lignes du catalogue et n'était jamais repris ;
 *  - **garde anti-boucle** : `hydration_attempted_at` horodatée après CHAQUE
 *    tentative (succès comme échec) → une ligne que MU ne peut pas compléter
 *    sort du lot 30 jours au lieu de brûler le budget en boucle.
 */
@Injectable()
export class CatalogHydrationService {
  private readonly logger = new Logger(CatalogHydrationService.name);

  /** Garde anti-boucle : délai avant de re-tenter une ligne déjà tentée. */
  private static readonly RETRY_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

  /**
   * Budget d'hydratation par défaut (2026-08-28 : 200 → 800). 800 × 2 s
   * ≈ 27 min à 30 req/min, moitié du plafond MU anonyme. À 200/nuit, le
   * critère élargi mettait plusieurs semaines à rattraper le stock.
   */
  private static readonly DEFAULT_BUDGET = 800;

  private readonly delayMs: number;
  private readonly budget: number;

  /** Injectable pour les tests (évite les vrais timers). */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @InjectRepository(CatalogSyncState)
    private readonly stateRepository: Repository<CatalogSyncState>,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    private readonly mangasService: MangasService,
    config: ConfigService,
  ) {
    this.delayMs = intFromConfig(config, 'CATALOG_SYNC_DELAY_MS', 2000);
    this.budget = intFromConfig(
      config,
      'CATALOG_SYNC_HYDRATION_BUDGET',
      CatalogHydrationService.DEFAULT_BUDGET,
    );
  }

  /** @returns nombre de mangas hydratés avec succès. */
  async hydrateIncompleteRows(budget: number = this.budget): Promise<number> {
    const retryBefore = new Date(
      Date.now() - CatalogHydrationService.RETRY_AFTER_MS,
    );

    const rows = await this.mangaRepository
      .createQueryBuilder('m')
      .where(
        '(m.genres IS NULL OR m.rating IS NULL OR m.year IS NULL OR m.medium_cover_url IS NULL)',
      )
      .andWhere(
        '(m.hydration_attempted_at IS NULL OR m.hydration_attempted_at < :retryBefore)',
        { retryBefore },
      )
      // Priorité 0 : le titre est recommandé quelque part → il est affiché sur
      // des cartes. Priorité 1 : le reste du catalogue.
      .orderBy(
        'CASE WHEN EXISTS (SELECT 1 FROM manga_recommendation mr WHERE mr.recommended_mu_id = m.mu_id) THEN 0 ELSE 1 END',
        'ASC',
      )
      .addOrderBy('m.hydration_attempted_at', 'ASC', 'NULLS FIRST')
      .addOrderBy('m.id', 'ASC')
      .limit(budget)
      .getMany();
    if (rows.length === 0) return 0;

    let hydrated = 0;
    for (const manga of rows) {
      try {
        await this.mangasService.getMangaDetails(Number(manga.mu_id));
        hydrated += 1;
      } catch (err) {
        this.logger.warn(
          `Hydratation mu_id=${manga.mu_id} en échec : ${
            (err as Error)?.message ?? err
          }`,
        );
      }
      // Marquage APRÈS tentative, succès ou échec : c'est ce qui garantit la
      // progression du job d'une nuit à l'autre.
      await this.markHydrationAttempt(manga.mu_id);
      await this.sleep(this.delayMs);
    }

    await this.persistState();
    this.logger.log(
      `Hydratation : ${hydrated}/${rows.length} manga(s) complétés`,
    );
    return hydrated;
  }

  /**
   * Horodate la tentative d'hydratation d'une ligne. Best-effort : un échec
   * d'écriture est loggé mais n'interrompt pas la boucle (au pire la ligne
   * sera re-tentée au prochain run).
   */
  private async markHydrationAttempt(muId: string): Promise<void> {
    try {
      await this.mangaRepository.update(
        { mu_id: muId },
        { hydration_attempted_at: new Date() },
      );
    } catch (err) {
      this.logger.warn(
        `Marquage hydration_attempted_at mu_id=${muId} en échec : ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }

  /** Trace le passage du job dans `catalog_sync_state` (ligne `hydration`). */
  private async persistState(): Promise<void> {
    const existing = await this.stateRepository.findOneBy({
      job_name: 'hydration',
    });
    const state =
      existing ??
      this.stateRepository.create({
        job_name: 'hydration',
        last_completed_page: 0,
        total_pages: null,
        last_run_at: null,
        last_run_status: null,
        consecutive_failures: 0,
        completed_at: null,
        saturated: false,
        total_hits: null,
      });
    state.last_run_at = new Date();
    state.last_run_status = 'completed';
    await this.stateRepository.save(state);
  }
}
