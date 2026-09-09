import { WriteOutcome } from './reader-signal-writer.service';

/**
 * Bilan d'un run de collecte — c'est ce que les logs et les tests observent.
 *
 * Aucune donnée personnelle : que des compteurs, plus une ventilation par
 * `manga.type`. C'est elle qui doit permettre de répondre, après quelques
 * nuits, à « est-ce que ce chemin produit assez de signal sur le
 * manhwa/manhua ? » — le point faible du produit.
 */
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

export function emptyOutcome(budget: number): ReaderSignalOutcome {
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

/** Cumule un lot d'écritures dans le bilan du run. */
export function accumulate(
  outcome: ReaderSignalOutcome,
  written: WriteOutcome,
): void {
  outcome.rowsWritten += written.written;
  outcome.rowsWithRating += written.withRating;
  outcome.rowsUnknownSeries += written.unknownSeries;
  for (const [type, count] of Object.entries(written.byMangaType)) {
    outcome.rowsByMangaType[type] =
      (outcome.rowsByMangaType[type] ?? 0) + count;
  }
}

/** `clé=valeur` séparés par des espaces, pour les logs. */
export function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return 'aucune';
  return entries.map(([key, value]) => `${key}=${value}`).join(' ');
}

/**
 * Budget, cadence MU et disjoncteur d'un run, partagés par les deux étages
 * du job.
 *
 * Un SEUL objet compte les requêtes envoyées à MangaUpdates : découverte et
 * extraction puisent dans la même enveloppe, sans quoi le budget de la nuit
 * ne voudrait rien dire. C'est aussi lui qui impose la cadence — le délai
 * est appliqué AVANT l'appel et non après, pour qu'un run interrompu en
 * plein milieu (redémarrage, disjoncteur) ne laisse jamais deux requêtes
 * séparées de moins de `delayMs`, même à cheval sur deux runs.
 *
 * Le disjoncteur compte les échecs CONSÉCUTIFS (remis à 0 par tout succès) :
 * MU qui hoquette ne doit pas arrêter la nuit, MU qui ne répond plus doit
 * l'arrêter immédiatement plutôt que de consommer 1 000 requêtes en pure
 * perte — et de ressembler à une attaque.
 */
export class ReaderSignalRunBudget {
  used = 0;
  circuitBroken = false;
  private consecutiveFailures = 0;

  constructor(
    private readonly budget: number,
    private readonly maxFailures: number,
    private readonly delayMs: number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  get remaining(): number {
    return this.budget - this.used;
  }

  /** `false` dès que le budget est épuisé ou que le disjoncteur a sauté. */
  get canContinue(): boolean {
    return this.remaining > 0 && !this.circuitBroken;
  }

  /** Décompte une requête, respecte la cadence MU, puis exécute. */
  async spend<T>(call: () => Promise<T>): Promise<T> {
    if (this.used > 0) await this.sleep(this.delayMs);
    this.used += 1;
    return call();
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxFailures) this.circuitBroken = true;
  }
}
