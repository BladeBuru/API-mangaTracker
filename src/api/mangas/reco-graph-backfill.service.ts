import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { intFromConfig } from './catalog-sync.mapper';
import { MU_DETAIL_URL } from './constants';
import { Manga } from './manga.entity';
import { fetchWithMuBackoff } from './mu-backoff';
import { MuJobLockService } from './mu-job-lock.service';
import { RecoGraphIngestService } from './reco-graph-ingest.service';

/** Bilan d'un run, pour les logs et les tests. */
export interface RecoGraphBackfillOutcome {
  /** Fiches `/series/{id}` demandées. */
  attempted: number;
  /** … dont ingérées sans erreur. */
  ingested: number;
  /** Liens écrits (toutes origines confondues). */
  links: number;
  /** Séries encore éligibles au début du run (observabilité). */
  eligible: number;
  /** Run interrompu par le disjoncteur (échecs MU consécutifs). */
  circuitBroken: boolean;
}

/**
 * Rattrapage nocturne du **graphe de recommandations** : lit la fiche
 * `/v1/series/{id}` des séries qui comptent et en persiste les trois
 * voisinages via `RecoGraphIngestService`.
 *
 * ## Pourquoi un job dédié alors que l'hydratation ramène déjà des fiches
 *
 * `CatalogHydrationService` lit 800 fiches par nuit — et depuis 2026-09-09
 * chacune alimente le graphe gratuitement. Mais elle ne cible que les lignes
 * INCOMPLÈTES (genres/note/année/cover/titres alternatifs manquants) : une
 * fiche déjà complète, y compris celles de la bibliothèque de l'utilisateur,
 * n'y passe jamais. Il restait 140 031 lignes incomplètes au 2026-09-09, soit
 * ~175 nuits avant que le graphe ne soit couvert — et dans un ordre qui n'est
 * pas celui de l'utilité.
 *
 * ## Ordre de parcours (c'est lui qui décide de ce que l'utilisateur voit)
 *
 * 0. séries présentes dans au moins une bibliothèque (`user_manga`) — le
 *    signal d'usage le plus fort, et la SOURCE des recommandations : sans son
 *    voisinage, un titre de la bibliothèque ne produit rien (12 titres sur 77
 *    avaient un lien sortant au 2026-09-09) ;
 * 1. séries déjà servies en recommandation (`manga_recommendation`) — elles
 *    sont affichées sur des cartes, leur propre voisinage prolonge le graphe ;
 * 2. séries éligibles aux sections de l'accueil (cover + genres + note ≥ 7,
 *    mêmes prédicats que `HomeSectionQueryBuilder`) ;
 * 3. le reste du catalogue, les mieux notées d'abord.
 *
 * À l'intérieur de chaque rang : note décroissante puis `id`, tri stable.
 *
 * ## Curseur et reprise
 *
 * Le curseur réel est le filigrane `manga.reco_graph_attempted_at`, horodaté
 * après CHAQUE tentative (succès comme échec) : l'ordre ci-dessus change d'une
 * nuit à l'autre (un titre entre en bibliothèque, une note arrive), un simple
 * `OFFSET` sauterait des séries. La ligne `reco-graph` de
 * `catalog_sync_state` porte l'état de la passe — `last_completed_page` =
 * nombre de séries traitées depuis le début de la passe courante,
 * `total_pages` = séries éligibles au dernier run, `completed_at` horodatée
 * quand plus rien n'est éligible (passe terminée, le compteur repart à 0).
 *
 * ## Politique réseau
 *
 * 1 requête / `CATALOG_SYNC_DELAY_MS` (2 s), backoff partagé
 * `mu-backoff.ts` (5/10/20/40 s sur 429/5xx), verrou MU partagé
 * (`MuJobLockService`, « skip, jamais attendre »), disjoncteur après
 * `MAX_CONSECUTIVE_FAILURES` échecs d'affilée.
 *
 * **Créneau : 07:00 + jitter 0-10 min.** Les créneaux MU occupés sont 01:00
 * (rattrapage de type, ~10 min), 02:00 (sorties, +10 min de jitter), 03:30
 * (catalogue + hydratation enchaînée, terminée à 04:19 le 2026-09-09).
 * 07:00 laisse près de trois heures de marge après l'hydratation et évite
 * les créneaux 05:30 / 06:30 qu'un chantier parallèle (collecte de listes de
 * lecteurs MU puis agrégation) occupe. Le budget par défaut (1 500 fiches ×
 * 2 s ≈ 50 min) s'achève vers 07:50, très loin du 01:00 suivant. Le verrou
 * partagé reste le garde-fou si un run déborde ou si un déploiement tombe
 * pendant un job.
 */
@Injectable()
export class RecoGraphBackfillService {
  private readonly logger = new Logger(RecoGraphBackfillService.name);

  /** Nom sous lequel ce job prend le verrou MU. */
  static readonly LOCK_NAME = 'reco-graph';

  /** Ligne d'état dans `catalog_sync_state`. */
  static readonly JOB_NAME = 'reco-graph';

  /**
   * 1 500 fiches × 2 s ≈ 50 min — le même ordre de grandeur que
   * l'hydratation (800) et le rattrapage de type (200 pages), sur un créneau
   * qui n'est partagé avec personne.
   */
  private static readonly DEFAULT_BUDGET = 1500;

  /** Une série n'est relue que passé ce délai (le graphe MU bouge peu). */
  private static readonly DEFAULT_REFRESH_DAYS = 60;

  /** Jitter max avant le run nocturne (10 min). */
  private static readonly JITTER_MAX_MS = 10 * 60 * 1000;

  /**
   * Disjoncteur : une panne MU ne doit pas faire enchaîner 1 500 requêtes et
   * des heures de backoff dans la même nuit. Les filigranes déjà posés
   * garantissent que la nuit suivante reprend là où on s'est arrêté.
   */
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;

  private readonly enabled: boolean;
  private readonly budget: number;
  private readonly refreshMs: number;
  private readonly delayMs: number;

  /** Injectable pour les tests (évite les vrais timers). */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    @InjectRepository(CatalogSyncState)
    private readonly stateRepository: Repository<CatalogSyncState>,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    private readonly httpService: HttpService,
    private readonly ingestService: RecoGraphIngestService,
    private readonly lock: MuJobLockService,
    config: ConfigService,
  ) {
    const enabledRaw = config.get<string>('RECO_GRAPH_BACKFILL_ENABLED');
    this.enabled =
      enabledRaw !== undefined && enabledRaw !== ''
        ? enabledRaw === 'true'
        : config.get<string>('NODE_ENV') !== 'test';
    this.budget = intFromConfig(
      config,
      'RECO_GRAPH_BACKFILL_PAGES_PER_RUN',
      RecoGraphBackfillService.DEFAULT_BUDGET,
    );
    this.refreshMs =
      intFromConfig(
        config,
        'RECO_GRAPH_BACKFILL_REFRESH_DAYS',
        RecoGraphBackfillService.DEFAULT_REFRESH_DAYS,
      ) *
      24 *
      60 *
      60 *
      1000;
    // Cadence MU partagée avec les autres jobs : une seule variable.
    this.delayMs = intFromConfig(config, 'CATALOG_SYNC_DELAY_MS', 2000);
  }

  /** Cron nocturne 07:00 (heure serveur) + jitter 0-10 min. */
  @Cron('0 0 7 * * *')
  async handleNightlyBackfill(): Promise<void> {
    if (!this.enabled) return;
    const jitterMs = Math.floor(
      Math.random() * RecoGraphBackfillService.JITTER_MAX_MS,
    );
    this.logger.log(
      `Rattrapage graphe de recos dans ${Math.round(
        jitterMs / 1000,
      )} s (jitter)`,
    );
    await this.sleep(jitterMs);
    await this.runOnce();
  }

  /**
   * Point d'entrée testable, sous verrou MU. `null` si un autre job MU est en
   * cours (skip, jamais d'attente — les filigranes sont persistés).
   */
  async runOnce(
    budget: number = this.budget,
  ): Promise<RecoGraphBackfillOutcome | null> {
    if (!this.lock.tryAcquire(RecoGraphBackfillService.LOCK_NAME)) {
      return null;
    }
    try {
      return await this.backfill(budget);
    } finally {
      this.lock.release(RecoGraphBackfillService.LOCK_NAME);
    }
  }

  /** Corps du run : sélection prioritaire, boucle MU, état persisté. */
  private async backfill(budget: number): Promise<RecoGraphBackfillOutcome> {
    const refreshBefore = new Date(Date.now() - this.refreshMs);
    const eligible = await this.countEligible(refreshBefore);
    const targets = await this.selectTargets(refreshBefore, budget);

    const outcome: RecoGraphBackfillOutcome = {
      attempted: 0,
      ingested: 0,
      links: 0,
      eligible,
      circuitBroken: false,
    };
    if (targets.length === 0) {
      await this.persistState(outcome, true);
      this.logger.log(
        '[reco-graph] aucune série à rattraper — passe terminée, curseur remis à 0',
      );
      return outcome;
    }

    let consecutiveFailures = 0;
    for (let i = 0; i < targets.length; i++) {
      const muId = Number(targets[i].mu_id);
      outcome.attempted += 1;
      try {
        const payload = await this.fetchSeries(muId);
        const ingested = await this.ingestService.ingestSeriesPayload(
          muId,
          payload,
        );
        outcome.ingested += 1;
        outcome.links += ingested.manual + ingested.category + ingested.related;
        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures += 1;
        this.logger.warn(
          `[reco-graph] fiche mu_id=${muId} en échec : ${
            (err as Error)?.message ?? err
          }`,
        );
      }
      // Filigrane APRÈS tentative, succès ou échec : c'est ce qui garantit la
      // progression d'une nuit à l'autre (doctrine `hydration_attempted_at`).
      await this.markAttempt(targets[i].mu_id);

      if (
        consecutiveFailures >= RecoGraphBackfillService.MAX_CONSECUTIVE_FAILURES
      ) {
        outcome.circuitBroken = true;
        this.logger.error(
          `[reco-graph] ${consecutiveFailures} fiches consécutives en échec — ` +
            'run interrompu (MU probablement indisponible), filigranes conservés',
        );
        break;
      }
      if (i < targets.length - 1) await this.sleep(this.delayMs);
    }

    await this.persistState(outcome, false);
    this.logger.log(
      `[reco-graph] ${outcome.ingested}/${outcome.attempted} fiche(s) ingérée(s), ` +
        `${outcome.links} lien(s) écrit(s), ${eligible} série(s) éligible(s)` +
        `${outcome.circuitBroken ? ' — disjoncteur déclenché' : ''}`,
    );
    return outcome;
  }

  /** GET `/v1/series/{id}` avec le backoff MU partagé. */
  private async fetchSeries(muId: number): Promise<unknown> {
    return fetchWithMuBackoff(
      async () => {
        const { data } = await firstValueFrom(
          this.httpService.get<unknown>(MU_DETAIL_URL.concat(muId.toString())),
        );
        return data;
      },
      `reco-graph série ${muId}`,
      this.logger,
      (ms) => this.sleep(ms),
    );
  }

  /**
   * Prédicat d'éligibilité : jamais visitée, ou visitée avant la fenêtre de
   * rafraîchissement. Partagé par le comptage et la sélection pour qu'ils ne
   * puissent pas diverger.
   */
  private eligibilityWhere(): string {
    return (
      '(m.reco_graph_attempted_at IS NULL OR ' +
      'm.reco_graph_attempted_at < :refreshBefore)'
    );
  }

  private countEligible(refreshBefore: Date): Promise<number> {
    return this.mangaRepository
      .createQueryBuilder('m')
      .where(this.eligibilityWhere(), { refreshBefore })
      .getCount();
  }

  /** Les `budget` séries les plus utiles à rattraper (cf. doc de classe). */
  private selectTargets(
    refreshBefore: Date,
    budget: number,
  ): Promise<{ mu_id: string }[]> {
    return this.mangaRepository
      .createQueryBuilder('m')
      .select('m.mu_id', 'mu_id')
      .where(this.eligibilityWhere(), { refreshBefore })
      .orderBy(
        'CASE ' +
          'WHEN EXISTS (SELECT 1 FROM user_manga um WHERE um.manga_id = m.mu_id) THEN 0 ' +
          'WHEN EXISTS (SELECT 1 FROM manga_recommendation mr WHERE mr.recommended_mu_id = m.mu_id) THEN 1 ' +
          'WHEN (m.medium_cover_url IS NOT NULL AND m.genres IS NOT NULL AND m.rating >= 7) THEN 2 ' +
          'ELSE 3 END',
        'ASC',
      )
      .addOrderBy('m.rating', 'DESC', 'NULLS LAST')
      .addOrderBy('m.id', 'ASC')
      .limit(budget)
      .getRawMany<{ mu_id: string }>();
  }

  /** Horodate la tentative. Best-effort : un échec d'écriture ne casse rien. */
  private async markAttempt(muId: string): Promise<void> {
    try {
      await this.mangaRepository.update(
        { mu_id: muId },
        { reco_graph_attempted_at: new Date() },
      );
    } catch (err) {
      this.logger.warn(
        `[reco-graph] filigrane mu_id=${muId} non posé : ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }

  /**
   * Persiste la ligne `reco-graph` de `catalog_sync_state`.
   *
   * @param drained `true` quand plus aucune série n'était éligible : la passe
   *   est terminée, le compteur repart à 0 et `completed_at` est horodatée.
   */
  private async persistState(
    outcome: RecoGraphBackfillOutcome,
    drained: boolean,
  ): Promise<void> {
    const existing = await this.stateRepository.findOneBy({
      job_name: RecoGraphBackfillService.JOB_NAME,
    });
    const state =
      existing ??
      this.stateRepository.create({
        job_name: RecoGraphBackfillService.JOB_NAME,
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
    state.total_pages = outcome.eligible;
    if (drained) {
      state.last_completed_page = 0;
      state.completed_at = new Date();
      state.last_run_status = 'completed';
      state.consecutive_failures = 0;
    } else {
      state.last_completed_page =
        (state.last_completed_page ?? 0) + outcome.attempted;
      state.last_run_status = outcome.circuitBroken ? 'partial' : 'completed';
      state.consecutive_failures = outcome.circuitBroken
        ? (state.consecutive_failures ?? 0) + 1
        : 0;
    }
    await this.stateRepository.save(state);
  }
}
