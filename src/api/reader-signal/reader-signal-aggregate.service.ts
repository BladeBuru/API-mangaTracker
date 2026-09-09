import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { intFromConfig } from '@/api/mangas/catalog-sync.mapper';
import { NSFW_GENRES } from '@/api/mangas/constants';
import { ReaderCooccurrence } from './reader-cooccurrence.entity';
import {
  DISCOVERY_TYPES,
  nsfwFilterSql,
} from './reader-signal-priority.service';
import {
  affinitySqlExpression,
  pairContributionSql,
} from './reader-signal-weights';

/** Bilan d'un recalcul d'agrégats. */
export interface AggregateOutcome {
  /** Lignes `reader_cooccurrence` écrites (les deux sens comptés). */
  pairsWritten: number;
  /** Œuvres apparaissant au moins une fois comme `mu_id_a`. */
  seriesCovered: number;
  /** Paires à score négatif — le signal de répulsion qui manquait. */
  negativePairs: number;
  /** Lecteurs retenus (dans les bornes de taille de vecteur). */
  readersUsed: number;
  /** Millisecondes de calcul. */
  durationMs: number;
}

/**
 * Agrégation LOCALE des co-occurrences œuvre↔œuvre depuis `reader_signal`.
 *
 * **Aucune requête réseau.** Ce job ne fait que du SQL : il peut donc être
 * relancé à volonté, il ne consomme aucun quota MangaUpdates et ne prend pas
 * le verrou MU.
 *
 * ## Ce qu'il produit, et pourquoi c'est le cœur du dispositif RGPD
 *
 * Les lignes brutes (« ce lecteur a lu cette œuvre ») sont des données
 * personnelles. Les co-occurrences (« ces deux œuvres reviennent chez les
 * mêmes lecteurs ») n'en sont plus : plus aucun individu n'y est
 * représenté, même pseudonymement. C'est ce passage qui autorise la purge
 * des lignes brutes (`purgeRawSignal`) et fait sortir le dispositif du champ
 * des données personnelles une fois le calcul fait.
 *
 * ## Pondération
 *
 * L'affinité d'une ligne vient de `reader-signal-weights.ts` et est
 * reprojetée en SQL par `affinitySqlExpression` — jamais recopiée : les
 * deux implémentations doivent rester identiques par construction.
 *
 * Contribution d'un lecteur à une paire : `w(a) × w(b)`, **sauf** quand les
 * deux affinités sont négatives, où la contribution est nulle. Sans cette
 * règle, deux négatifs se multiplieraient en un positif : « les lecteurs qui
 * ont abandonné A ont aussi abandonné B » deviendrait une raison de
 * recommander B à qui aime A. Ce que ce croisement dit en réalité, c'est la
 * tolérance du lecteur, pas la parenté des titres — et le volume
 * d'abandons est trop faible (mesuré : ~5× moins que les lectures
 * terminées) pour en tirer une similarité fiable.
 *
 * Le cas mixte (un positif, un négatif) est **conservé** et donne un score
 * négatif : « les lecteurs qui aiment A abandonnent B ». C'est exactement le
 * signal de répulsion qui manque totalement au produit.
 *
 * ## Périmètre
 *
 * Les paires ne sont calculées que sur le **focus set** — les mêmes œuvres
 * que celles ciblées par la découverte. Au-delà, l'auto-jointure exploserait
 * (147 261² paires possibles) pour produire des voisinages qu'aucune
 * collecte n'alimente.
 */
@Injectable()
export class ReaderSignalAggregateService {
  private readonly logger = new Logger(ReaderSignalAggregateService.name);

  private readonly enabled: boolean;
  private readonly focusPerType: number;
  private readonly minCoReaders: number;
  private readonly maxVectorSize: number;
  private readonly rawTtlDays: number;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(ReaderCooccurrence)
    private readonly cooccurrenceRepository: Repository<ReaderCooccurrence>,
    config: ConfigService,
  ) {
    const enabledRaw = config.get<string>('READER_SIGNAL_ENABLED');
    this.enabled =
      enabledRaw !== undefined && enabledRaw !== ''
        ? enabledRaw === 'true'
        : config.get<string>('NODE_ENV') !== 'test';
    this.focusPerType = intFromConfig(config, 'READER_SIGNAL_TYPE_DEPTH', 1500);
    // 3 lecteurs communs minimum : en dessous, une « similarité » n'est
    // qu'une coïncidence, et le volume de paires explose (l'essentiel de la
    // masse d'une auto-jointure est constitué de paires vues une seule fois).
    this.minCoReaders = intFromConfig(
      config,
      'READER_SIGNAL_MIN_CO_READERS',
      3,
    );
    // Un lecteur à 5 000 titres dans le focus set produirait 12,5 M de
    // paires à lui seul, pour une information quasi nulle (il a « tout
    // lu »). On l'exclut plutôt que de le laisser dominer l'agrégat.
    this.maxVectorSize = intFromConfig(
      config,
      'READER_SIGNAL_MAX_VECTOR_SIZE',
      800,
    );
    this.rawTtlDays = intFromConfig(config, 'READER_SIGNAL_RAW_TTL_DAYS', 0);
  }

  /**
   * Cron nocturne 06:30 — après la collecte (05:30, ~33 min au pire).
   * Purement local : aucun quota MU en jeu, aucun verrou à prendre.
   */
  @Cron('0 30 6 * * *')
  async handleNightlyAggregate(): Promise<void> {
    if (!this.enabled) return;
    await this.recompute();
    await this.purgeRawSignal();
  }

  /**
   * Recalcule INTÉGRALEMENT `reader_cooccurrence` depuis `reader_signal`.
   *
   * Recalcul complet et non incrémental : les normes de chaque œuvre
   * changent dès qu'un lecteur est ajouté, donc tous les scores qui la
   * touchent bougent. Un incrémental correct reviendrait à tout recalculer
   * de toute façon, avec en prime le risque d'un état à moitié à jour.
   *
   * Idempotent : deux exécutions consécutives sur le même signal produisent
   * exactement la même table. Tout se passe dans UNE transaction — la table
   * n'est jamais visible vide.
   */
  async recompute(): Promise<AggregateOutcome> {
    const startedAt = Date.now();
    const params = [
      [...NSFW_GENRES],
      this.focusPerType,
      [...DISCOVERY_TYPES],
      this.maxVectorSize,
      this.minCoReaders,
    ];

    let readersUsed = 0;
    await this.dataSource.transaction(async (manager) => {
      const readers: Array<{ count: string }> = await manager.query(
        `WITH ${this.cteSql()} SELECT COUNT(*)::text AS count FROM bounded`,
        params,
      );
      readersUsed = Number(readers?.[0]?.count ?? 0);

      // TRUNCATE est transactionnel sous PostgreSQL : en cas d'échec du
      // INSERT, la table reste intacte. Aucune clé étrangère ne la vise.
      await manager.query('TRUNCATE TABLE reader_cooccurrence');
      await manager.query(this.insertSql(), params);
    });

    const stats = await this.readStats();
    const outcome: AggregateOutcome = {
      ...stats,
      readersUsed,
      durationMs: Date.now() - startedAt,
    };
    this.logger.log(
      `[reader-signal:agg] ${outcome.pairsWritten} paire(s) sur ` +
        `${outcome.seriesCovered} œuvre(s), dont ${outcome.negativePairs} ` +
        `à score négatif | ${readersUsed} lecteur(s) retenu(s) | ` +
        `${outcome.durationMs} ms`,
    );
    return outcome;
  }

  /**
   * Purge des lignes brutes plus anciennes que `READER_SIGNAL_RAW_TTL_DAYS`.
   *
   * **Désactivée par défaut (`0`)**, et c'est délibéré : tant que la
   * pondération et le périmètre du focus set bougent, il faut pouvoir
   * recalculer les agrégats depuis le brut. Une fois le dispositif stabilisé,
   * poser une durée (90 jours par exemple) réduit la table à une fenêtre
   * glissante — c'est le geste qui matérialise la minimisation exigée par le
   * RGPD, les agrégats survivant à la purge.
   *
   * Les profils de lecteurs purgés partent avec : garder un `reader_profile`
   * sans aucune ligne de signal ne conserverait qu'une trace d'existence,
   * sans utilité.
   */
  async purgeRawSignal(): Promise<number> {
    if (this.rawTtlDays <= 0) return 0;
    const cutoff = new Date(Date.now() - this.rawTtlDays * 86_400_000);
    let purged = 0;
    await this.dataSource.transaction(async (manager) => {
      const result = await manager.query(
        `DELETE FROM reader_signal WHERE collected_at < $1`,
        [cutoff],
      );
      purged = Number(result?.[1] ?? result?.rowCount ?? 0) || 0;
      await manager.query(
        `DELETE FROM reader_profile p
          WHERE p.last_collected_at < $1
            AND NOT EXISTS (
              SELECT 1 FROM reader_signal s WHERE s.user_hash = p.user_hash
            )`,
        [cutoff],
      );
    });
    this.logger.log(
      `[reader-signal:agg] purge des lignes brutes > ${this.rawTtlDays} j : ` +
        `${purged} ligne(s) supprimée(s)`,
    );
    return purged;
  }

  /**
   * CTE communes : focus set, pondération, déduplication par lecteur, et
   * bornage de la taille des vecteurs.
   *
   * Paramètres : `$1` genres NSFW, `$2` profondeur par type, `$3` types
   * échantillonnés, `$4` taille max de vecteur.
   */
  private cteSql(): string {
    return `
      focus AS (
        SELECT DISTINCT um.manga_id AS mu_id FROM user_manga um
        UNION
        SELECT mu_id FROM (
          SELECT m.mu_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY m.type ORDER BY m.rating DESC, m.mu_id
                 ) AS rn
            FROM manga m
           WHERE m.type = ANY($3)
             AND m.rating IS NOT NULL
             AND ${nsfwFilterSql('m', '$1')}
        ) ranked
        WHERE ranked.rn <= $2
      ),
      weighted AS (
        SELECT rs.user_hash,
               rs.mu_id,
               (${affinitySqlExpression('rs')})::double precision AS w
          FROM reader_signal rs
          JOIN focus f ON f.mu_id = rs.mu_id
      ),
      -- Une seule affinité par (lecteur, œuvre) : un lecteur peut ranger la
      -- même série dans deux listes (une liste personnalisée porte le type
      -- de la liste native dont elle dérive — mesuré). On garde la plus
      -- TRANCHÉE (|w| max) : « terminé » l'emporte sur « en pause », et un
      -- « terminé » mal noté l'emporte sur une simple intention.
      sig AS (
        SELECT DISTINCT ON (user_hash, mu_id) user_hash, mu_id, w
          FROM weighted
         ORDER BY user_hash, mu_id, ABS(w) DESC
      ),
      bounded AS (
        SELECT user_hash FROM sig
         GROUP BY user_hash
        HAVING COUNT(*) >= 2 AND COUNT(*) <= $4
      ),
      kept AS (
        SELECT s.* FROM sig s JOIN bounded b ON b.user_hash = s.user_hash
      ),
      norms AS (
        SELECT mu_id, SQRT(SUM(w * w)) AS n FROM kept GROUP BY mu_id
      ),
      pairs AS (
        SELECT a.mu_id AS mu_a,
               b.mu_id AS mu_b,
               COUNT(*)::int AS co_readers,
               SUM(${pairContributionSql('a.w', 'b.w')}) AS weight
          FROM kept a
          JOIN kept b ON b.user_hash = a.user_hash AND b.mu_id > a.mu_id
         GROUP BY a.mu_id, b.mu_id
        HAVING COUNT(*) >= $5
      ),
      scored AS (
        SELECT p.mu_a, p.mu_b, p.co_readers, p.weight,
               CASE WHEN na.n > 0 AND nb.n > 0
                    THEN p.weight / (na.n * nb.n) ELSE 0 END AS score
          FROM pairs p
          JOIN norms na ON na.mu_id = p.mu_a
          JOIN norms nb ON nb.mu_id = p.mu_b
      )
    `;
  }

  /**
   * Insertion des paires dans les DEUX sens.
   *
   * Le score cosinus est symétrique, mais le moteur lira toujours
   * `WHERE mu_id_a = ?` : stocker `(a,b)` et `(b,a)` échange un doublement
   * du volume contre une lecture indexée triviale sur le chemin chaud.
   */
  private insertSql(): string {
    return `
      WITH ${this.cteSql()}
      INSERT INTO reader_cooccurrence
        (mu_id_a, mu_id_b, co_readers, weight, score, computed_at)
      SELECT mu_a, mu_b, co_readers, weight, score, NOW() FROM scored
      UNION ALL
      SELECT mu_b, mu_a, co_readers, weight, score, NOW() FROM scored
    `;
  }

  /** Statistiques de la table fraîchement écrite (diagnostic). */
  private async readStats(): Promise<
    Pick<AggregateOutcome, 'pairsWritten' | 'seriesCovered' | 'negativePairs'>
  > {
    const rows: Array<{ pairs: string; series: string; negative: string }> =
      await this.cooccurrenceRepository.query(
        `SELECT COUNT(*)::text AS pairs,
                COUNT(DISTINCT mu_id_a)::text AS series,
                COUNT(*) FILTER (WHERE score < 0)::text AS negative
           FROM reader_cooccurrence`,
      );
    const row = rows?.[0];
    return {
      pairsWritten: Number(row?.pairs ?? 0),
      seriesCovered: Number(row?.series ?? 0),
      negativePairs: Number(row?.negative ?? 0),
    };
  }
}
