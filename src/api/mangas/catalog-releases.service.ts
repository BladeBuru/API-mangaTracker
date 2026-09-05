import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { In, Repository } from 'typeorm';
import { CatalogSyncState } from './catalog-sync-state.entity';
import { intFromConfig } from './catalog-sync.mapper';
import { MU_RELEASES_URL } from './constants';
import { Manga } from './manga.entity';
import { ReadingStatusAutoUpdateService } from '@/api/library/reading-status-auto-update.service';
import { fetchWithMuBackoff } from './mu-backoff';
import { MuJobLockService } from './mu-job-lock.service';
import {
  extractReleaseUpdates,
  maxTimeAdded,
  MuReleasesBody,
  MuReleaseResult,
  ReleasesPage,
  ReleaseUpdate,
} from './mu-release.mapper';

/** Bilan d'un run, pour les logs et les tests. */
export interface ReleasesSyncOutcome {
  /** Pages MU réellement demandées. */
  pagesFetched: number;
  /** Sorties exploitables vues (dédoublonnées par série). */
  releasesSeen: number;
  /** Séries présentes en base et effectivement mises à jour. */
  seriesUpdated: number;
  /** Séries inconnues de la base — ignorées, JAMAIS créées. */
  seriesUnknown: number;
  /**
   * Entrées bibliothèque « à jour » basculées en « en cours » parce que le
   * total de leur manga a augmenté (cf. `ReadingStatusAutoUpdateService`).
   */
  statusFlips: number;
  /** Le run s'est arrêté sur un échec → le curseur n'avance pas. */
  failed: boolean;
}

/**
 * Job nocturne de synchronisation des **dernières sorties** MangaUpdates.
 *
 * ## Pourquoi ce job
 *
 * Le catalogue (`CatalogSyncService`) découvre des SÉRIES ; il ne dit rien du
 * nombre de chapitres parus. `manga.total_chapters` n'était alimenté que par
 * `getMangaDetails` (ouverture d'une fiche) et par le signalement
 * communautaire (`ChapterReportService`) — d'où les remontées utilisateurs
 * « MangaUpdates est en retard sur le nombre de chapitres ». Ce job attaque
 * la cause : il lit le flux des sorties et fait monter `total_chapters` sans
 * qu'aucun utilisateur ait à ouvrir la fiche ni à signaler quoi que ce soit.
 *
 * ## Incrémentalité
 *
 * `POST /v1/releases/search` avec `orderby: 'time'` renvoie les sorties par
 * `time_added` **strictement décroissant** (vérifié sur 100 records). Le job
 * pagine du plus récent au plus ancien et s'arrête dès qu'une page ne
 * contient plus rien de postérieur au curseur `cursor_time_added` persisté
 * dans `catalog_sync_state` (ligne `releases`).
 *
 * **Aucune sortie ne peut être manquée** par ce parcours : de nouvelles
 * sorties insérées PENDANT le run n'apparaissent qu'en tête de tri et
 * décalent les suivantes vers le bas — on peut donc revoir un enregistrement
 * (sans effet, l'écriture est idempotente), jamais en sauter un.
 *
 * ## Débit
 *
 * ~267 sorties/jour mesurées (journée pleine du 2026-08-26), soit **3 pages
 * de 100 par nuit**. Le job coûte donc ~6 s de requêtes en régime établi,
 * plafonné à `RELEASES_SYNC_MAX_PAGES`. Cron 02:00 : le catalogue démarre à
 * 03:30 (+ jitter 15 min), ce qui laisse 90 min de marge — les deux jobs ne
 * frappent jamais MU en même temps, le rythme reste à 1 req / 2 s.
 */
@Injectable()
export class CatalogReleasesService {
  private readonly logger = new Logger(CatalogReleasesService.name);

  /** Ligne `catalog_sync_state` portant le curseur du job. */
  static readonly JOB_NAME = 'releases';

  /** perpage max accepté par MU sur `/releases/search` (mesuré). */
  static readonly PER_PAGE = 100;

  /** Jitter max avant le run nocturne (10 min). */
  private static readonly JITTER_MAX_MS = 10 * 60 * 1000;

  private readonly enabled: boolean;
  private readonly maxPages: number;
  private readonly lookbackDays: number;
  private readonly delayMs: number;

  /** Nom sous lequel ce job prend le verrou MU partagé. */
  static readonly LOCK_NAME = 'releases';

  /** Injectable pour les tests (évite les vrais timers). */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(CatalogSyncState)
    private readonly stateRepository: Repository<CatalogSyncState>,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    private readonly lock: MuJobLockService,

    private readonly readingStatusAutoUpdate: ReadingStatusAutoUpdateService,
    config: ConfigService,
  ) {
    const enabledRaw = config.get<string>('RELEASES_SYNC_ENABLED');
    this.enabled =
      enabledRaw !== undefined && enabledRaw !== ''
        ? enabledRaw === 'true'
        : config.get<string>('NODE_ENV') !== 'test';
    this.maxPages = intFromConfig(config, 'RELEASES_SYNC_MAX_PAGES', 20);
    this.lookbackDays = intFromConfig(config, 'RELEASES_SYNC_LOOKBACK_DAYS', 7);
    // Rythme MU partagé avec le catalogue : une seule variable pour une seule
    // politique de débit.
    this.delayMs = intFromConfig(config, 'CATALOG_SYNC_DELAY_MS', 2000);
  }

  /** Cron nocturne 02:00 (heure serveur) + jitter 0-10 min. */
  @Cron('0 0 2 * * *')
  async handleNightlyReleasesSync(): Promise<void> {
    if (!this.enabled) return;
    const jitterMs = Math.floor(
      Math.random() * CatalogReleasesService.JITTER_MAX_MS,
    );
    this.logger.log(
      `Sync sorties dans ${Math.round(jitterMs / 1000)} s (jitter)`,
    );
    await this.sleep(jitterMs);
    await this.runOnce();
  }

  /**
   * Point d'entrée testable. No-op (warn) si un run est déjà en cours ou si
   * un autre job MU tient le verrou partagé (`MuJobLockService`).
   */
  async runOnce(): Promise<ReleasesSyncOutcome | null> {
    if (!this.lock.tryAcquire(CatalogReleasesService.LOCK_NAME)) {
      this.logger.warn(
        'Sync sorties déjà en cours — run ignoré (anti-réentrance)',
      );
      return null;
    }
    try {
      return await this.syncRecentReleases();
    } finally {
      this.lock.release(CatalogReleasesService.LOCK_NAME);
    }
  }

  /**
   * Parcourt les pages de sorties du plus récent au plus ancien jusqu'au
   * curseur, applique les mises à jour, puis persiste le nouveau curseur.
   */
  private async syncRecentReleases(): Promise<ReleasesSyncOutcome> {
    const state = await this.getOrCreateState();
    const cursor = this.effectiveCursor(state);

    const outcome: ReleasesSyncOutcome = {
      pagesFetched: 0,
      releasesSeen: 0,
      seriesUpdated: 0,
      seriesUnknown: 0,
      statusFlips: 0,
      failed: false,
    };
    /** Plus grand `time_added` vu sur l'ENSEMBLE du run — futur curseur. */
    let highWaterMark = cursor;

    for (let page = 1; page <= this.maxPages; page++) {
      let result: ReleasesPage;
      try {
        result = await this.fetchReleasesPage(page);
      } catch (err) {
        // Arrêt PROPRE : curseur inchangé (voir `persistCursor`).
        this.logger.warn(
          `[releases] arrêt sur la page ${page} : ${
            (err as Error)?.message ?? err
          } — curseur conservé, reprise au prochain run`,
        );
        outcome.failed = true;
        break;
      }

      outcome.pagesFetched += 1;
      if (result.records.length === 0) break;

      highWaterMark = Math.max(highWaterMark, maxTimeAdded(result.records));

      // Seules les sorties POSTÉRIEURES au curseur sont à traiter. Le reste
      // de la page a déjà été vu lors d'un run précédent.
      const fresh = result.records.filter(
        (item) => Number(item?.record?.time_added?.timestamp) > cursor,
      );
      if (fresh.length > 0) {
        const updates = extractReleaseUpdates(fresh);
        outcome.releasesSeen += updates.length;
        try {
          const applied = await this.applyUpdates(updates);
          outcome.seriesUpdated += applied.updated;
          outcome.seriesUnknown += applied.unknown;
          outcome.statusFlips += applied.statusFlips;
        } catch (err) {
          this.logger.warn(
            `[releases] échec d'écriture sur la page ${page} : ${
              (err as Error)?.message ?? err
            } — curseur conservé`,
          );
          outcome.failed = true;
          break;
        }
      }

      // Tri strictement décroissant : si la page ne contient plus rien de
      // postérieur au curseur, les pages suivantes sont encore plus anciennes.
      if (fresh.length < result.records.length) break;

      // Page incomplète = fin des résultats disponibles. Sans cette garde, un
      // rattrapage qui tombe pile sur une page partielle irait quand même
      // demander la suivante — une requête MU gratuite, chaque nuit.
      if (result.records.length < CatalogReleasesService.PER_PAGE) break;

      // Page pleine et intégralement fraîche → il reste probablement du
      // retard à rattraper. On respecte le rythme MU avant de continuer.
      await this.sleep(this.delayMs);
    }

    if (outcome.pagesFetched >= this.maxPages && !outcome.failed) {
      this.logger.warn(
        `[releases] plafond de ${this.maxPages} pages atteint — retard non ` +
          'entièrement rattrapé, la suite sera reprise au prochain run',
      );
    }

    await this.persistCursor(state, highWaterMark, outcome);
    this.logger.log(
      `[releases] ${outcome.pagesFetched} page(s), ${outcome.releasesSeen} ` +
        `sortie(s) exploitable(s), ${outcome.seriesUpdated} série(s) mise(s) à ` +
        `jour, ${outcome.seriesUnknown} inconnue(s) ignorée(s), ` +
        `${outcome.statusFlips} statut(s) « à jour » → « en cours »`,
    );
    return outcome;
  }

  /**
   * Curseur effectif du run. `null` (tout premier run) → fenêtre de rattrapage
   * bornée à `RELEASES_SYNC_LOOKBACK_DAYS`, et non « tout l'historique » : MU
   * plafonne `total_hits` à 10 000 et le but du job est de ne pas rater les
   * NOUVEAUX chapitres, pas de reconstruire le passé (dont l'hydratation et
   * le signalement communautaire s'occupent déjà).
   */
  private effectiveCursor(state: CatalogSyncState): number {
    const persisted = Number(state.cursor_time_added);
    if (Number.isFinite(persisted) && persisted > 0) return persisted;
    const lookbackMs = this.lookbackDays * 24 * 60 * 60 * 1000;
    return Math.floor((Date.now() - lookbackMs) / 1000);
  }

  /** POST MU `/releases/search`, une page, avec le backoff MU partagé. */
  async fetchReleasesPage(page: number): Promise<ReleasesPage> {
    return fetchWithMuBackoff(
      () => this.postReleasesPage(page),
      `releases page ${page}`,
      this.logger,
      this.sleep,
    );
  }

  private async postReleasesPage(page: number): Promise<ReleasesPage> {
    const payload = {
      // Tri par date d'AJOUT en base MU — seul champ monotone (cf.
      // `mu-release.mapper.ts`). `release_date` contient des dates aberrantes.
      orderby: 'time',
      // Indispensable : sans lui, `record.id` est un id de SORTIE et la
      // réponse ne contient aucun `series_id` exploitable.
      include_metadata: true,
      perpage: CatalogReleasesService.PER_PAGE,
      page,
    };
    const { data } = await firstValueFrom(
      this.httpService.post<MuReleasesBody>(MU_RELEASES_URL, payload),
    );
    const records: MuReleaseResult[] = data?.results ?? [];
    const totalHits = Number(data?.total_hits ?? records.length) || 0;
    return { records, totalHits };
  }

  /**
   * Applique les sorties aux lignes `manga` EXISTANTES.
   *
   * **Aucune création.** Une série inconnue est simplement ignorée. C'est un
   * choix délibéré, pas un raccourci : `/releases/search` n'applique pas
   * l'`exclude_genre` NSFW du catalogue et ne fournit ni année, ni note, ni
   * genres. Insérer des stubs depuis ce flux polluerait `manga` de séries
   * NSFW et de lignes vides qui (a) entreraient dans les pools de
   * recommandation, (b) consommeraient le budget d'hydratation — au détriment
   * des titres réellement vus par les utilisateurs. La découverte reste le
   * métier du catalogue.
   */
  private async applyUpdates(
    updates: ReleaseUpdate[],
  ): Promise<{ updated: number; unknown: number; statusFlips: number }> {
    if (updates.length === 0) return { updated: 0, unknown: 0, statusFlips: 0 };

    // Un seul SELECT pour savoir lesquelles existent, plutôt qu'un UPDATE à
    // vide par série inconnue (la grande majorité du flux MU).
    const known = await this.mangaRepository.find({
      where: { mu_id: In(updates.map((u) => u.muId)) },
      select: ['mu_id'],
    });
    const knownIds = new Set(known.map((m) => String(m.mu_id)));

    let updated = 0;
    let statusFlips = 0;
    for (const update of updates) {
      if (!knownIds.has(update.muId)) continue;
      // Invariant A-5 : `total_chapters` est monotone croissant. Une sortie
      // isolée d'un vieux chapitre (rescan, retraduction) ne doit JAMAIS faire
      // régresser un total déjà plus élevé — d'où GREATEST plutôt qu'une
      // affectation directe. La clause `total_chapters < :newTotal` ne change
      // pas le résultat (GREATEST y est déjà idempotent) : elle sert à savoir,
      // via `affected`, si le total a RÉELLEMENT monté.
      const result = await this.mangaRepository
        .createQueryBuilder()
        .update(Manga)
        .set({ total_chapters: () => 'GREATEST(total_chapters, :newTotal)' })
        .setParameter('newTotal', update.chapter)
        .where('mu_id = :muId', { muId: update.muId })
        .andWhere('total_chapters < :newTotal')
        .execute();
      updated += 1;

      // Nouveau chapitre paru → les lecteurs « à jour » de cette série ne le
      // sont plus. Une requête ensembliste par série dont le total a monté,
      // jamais par utilisateur.
      if (Number(result?.affected ?? 0) > 0) {
        statusFlips += await this.readingStatusAutoUpdate.flipCaughtUpToReading(
          update.muId,
        );
      }
    }
    return { updated, unknown: updates.length - updated, statusFlips };
  }

  /**
   * Persiste le curseur et le statut du run.
   *
   * **Le curseur n'avance QUE sur un run intégralement réussi.** Le parcours
   * va du plus récent au plus ancien : sur un échec en page 3, les sorties
   * des pages 1-2 sont traitées mais celles des pages 3+ (les plus ANCIENNES,
   * donc les plus proches du curseur) ne le sont pas. Avancer le curseur au
   * plus récent les enterrerait définitivement. On préfère re-parcourir la
   * fenêtre au prochain run : l'écriture `GREATEST` est idempotente, la
   * re-lecture ne coûte que quelques requêtes.
   */
  private async persistCursor(
    state: CatalogSyncState,
    highWaterMark: number,
    outcome: ReleasesSyncOutcome,
  ): Promise<void> {
    state.last_run_at = new Date();
    if (outcome.failed) {
      state.last_run_status = 'partial';
      state.consecutive_failures += 1;
    } else {
      state.cursor_time_added = String(highWaterMark);
      state.last_run_status = 'completed';
      state.consecutive_failures = 0;
      state.completed_at = new Date();
    }
    try {
      await this.stateRepository.save(state);
    } catch (err) {
      this.logger.error(
        `[releases] échec de persistance du curseur : ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }

  private async getOrCreateState(): Promise<CatalogSyncState> {
    const existing = await this.stateRepository.findOneBy({
      job_name: CatalogReleasesService.JOB_NAME,
    });
    if (existing) return existing;
    return this.stateRepository.create({
      job_name: CatalogReleasesService.JOB_NAME,
      last_completed_page: 0,
      total_pages: null,
      last_run_at: null,
      last_run_status: null,
      consecutive_failures: 0,
      completed_at: null,
      saturated: false,
      total_hits: null,
      cursor_time_added: null,
    });
  }
}
