import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { intFromConfig } from '@/api/mangas/catalog-sync.mapper';
import { MU_LIST_MAX_PER_PAGE, MuListsClient } from './mu-lists.client';
import { pagesNeeded, PublicListRef, RawSignalRow } from './mu-lists.mapper';
import {
  accumulate,
  ReaderSignalOutcome,
  ReaderSignalRunBudget,
} from './reader-signal-run';
import { ReaderSignalWriterService } from './reader-signal-writer.service';

/**
 * Étage d'EXTRACTION du job de collecte : pour un lecteur découvert, lire ses
 * listes publiques et persister leur contenu.
 *
 * ## Le contrat avec l'appelant
 *
 * `userId` est l'identifiant MangaUpdates BRUT — nécessaire pour appeler MU,
 * jamais persisté. `userHash` est sa forme pseudonymisée, la seule qui parte
 * en base. Ce service ne sait pas hacher : il reçoit les deux, ce qui rend
 * impossible d'écrire l'un pour l'autre par inadvertance.
 *
 * ## Coût mesuré
 *
 * 1 requête pour la liste des listes + 3,38 listes en moyenne (mesuré le
 * 2026-09-09 sur 8 comptes tirés au hasard, aucun sans liste publique), soit
 * **4,38 requêtes par lecteur**. Avec `perpage` à 1000 — le maximum
 * réellement accepté par MU — une liste tient presque toujours en une seule
 * requête (la plus grande observée : 926 titres).
 */
@Injectable()
export class ReaderSignalExtractionService {
  private readonly logger = new Logger(ReaderSignalExtractionService.name);

  private readonly perPage: number;
  private readonly maxListPages: number;

  constructor(
    private readonly client: MuListsClient,
    private readonly writer: ReaderSignalWriterService,
    config: ConfigService,
  ) {
    this.perPage = Math.min(
      intFromConfig(config, 'READER_SIGNAL_PER_PAGE', MU_LIST_MAX_PER_PAGE),
      MU_LIST_MAX_PER_PAGE,
    );
    // Garde-fou contre un compte à 50 000 titres qui mangerait le budget de
    // la nuit à lui seul. 3 pages × 1000 = 3 000 titres, largement au-delà
    // de tout ce qui a été observé.
    this.maxListPages = intFromConfig(
      config,
      'READER_SIGNAL_MAX_LIST_PAGES',
      3,
    );
  }

  /**
   * Lit les listes publiques d'un lecteur et persiste leur contenu.
   *
   * Un compte sans liste publique est un cas NORMAL, pas un échec : il est
   * marqué `empty` et ne sera pas retenté avant la fenêtre de
   * rafraîchissement. Le compter comme une panne le ferait bannir par le
   * plafond d'échecs et fausserait le disjoncteur.
   */
  async extractReader(
    userId: string,
    userHash: string,
    outcome: ReaderSignalOutcome,
    budget: ReaderSignalRunBudget,
  ): Promise<void> {
    let lists: PublicListRef[];
    try {
      lists = await budget.spend(() => this.client.fetchPublicLists(userId));
    } catch (err) {
      budget.recordFailure();
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
    budget.recordSuccess();
    if (lists.length === 0) {
      await this.writer.recordProfile(userHash, 'empty', 0, 0);
      outcome.readersEmpty += 1;
      return;
    }

    const collected: RawSignalRow[] = [];
    let failed = false;
    for (const list of lists) {
      if (!budget.canContinue) break;
      try {
        collected.push(...(await this.readList(userId, list, budget)));
      } catch (err) {
        failed = true;
        budget.recordFailure();
        this.logger.warn(
          `[reader-signal] liste ${list.listType} illisible : ${
            (err as Error)?.message ?? err
          }`,
        );
        break;
      }
      budget.recordSuccess();
    }

    const known = await this.writer.knownSeries(collected.map((r) => r.muId));
    const written = await this.writer.writeSignal(
      collected.map((row) => ({ userHash, ...row })),
      known,
    );
    accumulate(outcome, written);

    // Échec SANS aucune ligne récupérée : le lecteur reste à retenter.
    // Échec APRÈS une liste lue : ce qui est acquis est acquis, le profil
    // est marqué collecté pour ne pas re-payer les listes déjà obtenues.
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
    list: PublicListRef,
    budget: ReaderSignalRunBudget,
  ): Promise<RawSignalRow[]> {
    const first = await budget.spend(() =>
      this.client.fetchListPage(
        userId,
        list.listId,
        list.listType,
        1,
        this.perPage,
      ),
    );
    const rows = [...first.rows];
    // L'écho `per_page` fait foi : MU coerce silencieusement une valeur trop
    // grande à 25. S'y fier évite de croire qu'une liste de 900 titres tient
    // dans la page qu'on vient de lire.
    const effective = first.perPageEcho > 0 ? first.perPageEcho : this.perPage;
    const pages = pagesNeeded(first.totalHits, effective, this.maxListPages);
    for (let page = 2; page <= pages; page++) {
      if (budget.remaining <= 0) break;
      const next = await budget.spend(() =>
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
}
