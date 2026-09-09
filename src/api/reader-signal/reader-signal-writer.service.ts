import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { ReaderProfile, ReaderProfileStatus } from './reader-profile.entity';
import { ReaderSignal } from './reader-signal.entity';
import { ReaderListType } from './reader-signal-weights';

/**
 * Ligne prête à persister. Le lecteur y est **déjà** représenté par son
 * hash : le type lui-même interdit de passer un `user_id` MangaUpdates.
 */
export interface PersistableSignalRow {
  userHash: string;
  muId: string;
  listType: ReaderListType;
  rating: number | null;
}

/** Lignes écrites, ventilées pour l'observabilité. */
export interface WriteOutcome {
  /** Lignes présentées à l'INSERT (après filtrage des séries inconnues). */
  written: number;
  /** … dont porteuses d'une note. */
  withRating: number;
  /** Séries absentes du catalogue, donc ignorées. */
  unknownSeries: number;
  /** Ventilation par `manga.type` (`inconnu` pour un type NULL). */
  byMangaType: Record<string, number>;
}

/** Lignes insérées par requête. 500 × 5 paramètres = 2 500, loin du plafond
 * de 65 535 paramètres de PostgreSQL, et une taille de transaction qui reste
 * modeste si le run est interrompu. */
const INSERT_CHUNK = 500;

/**
 * Écritures du signal de lecture : c'est le SEUL endroit du module qui
 * touche `reader_signal` et `reader_profile`.
 *
 * Toutes les méthodes prennent un `userHash` **déjà calculé** — aucune ne
 * sait construire un hash, et aucune n'accepte un `user_id` MangaUpdates.
 * La séparation est volontaire : elle rend structurellement impossible
 * d'écrire un identifiant en clair, et elle est vérifiée par les tests
 * (`reader-signal-writer.service.spec.ts`).
 */
@Injectable()
export class ReaderSignalWriterService {
  private readonly logger = new Logger(ReaderSignalWriterService.name);

  constructor(
    @InjectRepository(ReaderSignal)
    private readonly signalRepository: Repository<ReaderSignal>,
    @InjectRepository(ReaderProfile)
    private readonly profileRepository: Repository<ReaderProfile>,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
  ) {}

  /**
   * Restreint un lot de `mu_id` à ceux que le catalogue connaît, et renvoie
   * leur type.
   *
   * Même doctrine que `CatalogReleasesService` : **aucune création de série
   * depuis un flux secondaire**. Une liste publique contient des titres
   * NSFW, des novels et des séries que notre catalogue n'a pas ingérées ;
   * les insérer ici polluerait `manga` et fabriquerait des co-occurrences
   * pointant vers des lignes vides. Le type ramené au passage sert à la
   * ventilation d'observabilité, sans requête supplémentaire.
   */
  async knownSeries(muIds: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (muIds.length === 0) return out;
    const unique = [...new Set(muIds)];
    for (let i = 0; i < unique.length; i += INSERT_CHUNK) {
      const rows = await this.mangaRepository.find({
        where: { mu_id: In(unique.slice(i, i + INSERT_CHUNK)) },
        select: ['mu_id', 'type'],
      });
      for (const row of rows) out.set(String(row.mu_id), row.type ?? null);
    }
    return out;
  }

  /**
   * Écrit un lot de lignes de signal, en ignorant les séries hors catalogue.
   *
   * Un seul point d'écriture pour les DEUX étages du job : la découverte
   * (beaucoup de lecteurs sur une même série) et l'extraction (un lecteur
   * sur beaucoup de séries) produisent la même forme de ligne. Deux méthodes
   * auraient signifié deux `INSERT` à garder synchronisés.
   *
   * Idempotent : `ON CONFLICT (user_hash, mu_id, list_type) DO UPDATE`. Une
   * note déjà connue n'est **jamais** écrasée par un `null` (`COALESCE`) —
   * même doctrine null-safe que `PROTECTED_NULLABLE_COLUMNS` côté catalogue.
   * Un lecteur qui masque ses notes après coup (`show_rating` désactivé) ne
   * doit pas effacer un signal déjà collecté légitimement.
   */
  async writeSignal(
    rows: PersistableSignalRow[],
    known: Map<string, string | null>,
  ): Promise<WriteOutcome> {
    const outcome: WriteOutcome = {
      written: 0,
      withRating: 0,
      unknownSeries: 0,
      byMangaType: {},
    };
    const keep = rows.filter((row) => {
      if (!known.has(row.muId)) {
        outcome.unknownSeries += 1;
        return false;
      }
      return true;
    });
    if (keep.length === 0) return outcome;

    const now = new Date();
    for (let i = 0; i < keep.length; i += INSERT_CHUNK) {
      const chunk = keep.slice(i, i + INSERT_CHUNK);
      const params: unknown[] = [now];
      const tuples = chunk.map((row) => {
        params.push(row.userHash, row.muId, row.listType, row.rating);
        const base = params.length;
        return `($${base - 3}, $${base - 2}, $${base - 1}, $${base}, $1)`;
      });
      // SQL brut plutôt que `orUpdate` du QueryBuilder : on a besoin d'une
      // EXPRESSION dans le `DO UPDATE SET` (`COALESCE`), que l'API TypeORM
      // ne sait pas produire — elle n'écrit que `col = EXCLUDED.col`.
      await this.signalRepository.query(
        `INSERT INTO reader_signal
           (user_hash, mu_id, list_type, rating, collected_at)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (user_hash, mu_id, list_type) DO UPDATE SET
           rating = COALESCE(EXCLUDED.rating, reader_signal.rating),
           collected_at = EXCLUDED.collected_at`,
        params,
      );
    }

    for (const row of keep) {
      outcome.written += 1;
      if (row.rating !== null) outcome.withRating += 1;
      const type = known.get(row.muId) ?? 'inconnu';
      outcome.byMangaType[type] = (outcome.byMangaType[type] ?? 0) + 1;
    }
    return outcome;
  }

  /**
   * Hash déjà collectés dans la fenêtre de fraîcheur, à ne PAS re-collecter.
   *
   * Sans ce filtre, le job repasserait chaque nuit sur les mêmes comptes :
   * `/lists/similar` renvoie toujours les 100 `user_id` les plus anciens
   * d'une série, donc la découverte re-propose massivement des lecteurs déjà
   * vus. Les profils en échec répété sont également écartés.
   */
  async findFreshReaders(
    hashes: string[],
    ttlDays: number,
    maxFailures: number,
  ): Promise<Set<string>> {
    const fresh = new Set<string>();
    if (hashes.length === 0) return fresh;
    const threshold = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
    const unique = [...new Set(hashes)];
    for (let i = 0; i < unique.length; i += INSERT_CHUNK) {
      const rows: Array<{ user_hash: string }> =
        await this.profileRepository.query(
          `SELECT user_hash FROM reader_profile
            WHERE user_hash = ANY($1)
              AND (last_collected_at >= $2 OR failure_count >= $3)`,
          [unique.slice(i, i + INSERT_CHUNK), threshold, maxFailures],
        );
      for (const row of rows) fresh.add(row.user_hash);
    }
    return fresh;
  }

  /**
   * Journalise l'extraction d'un lecteur (upsert sur `user_hash`).
   *
   * `failure_count` est remis à 0 sur toute tentative aboutie — y compris
   * `empty` : un compte sans liste publique n'est pas une panne, il ne doit
   * pas finir mis au ban comme un lecteur qui fait échouer MU.
   */
  async recordProfile(
    userHash: string,
    status: ReaderProfileStatus,
    listCount: number,
    rowCount: number,
  ): Promise<void> {
    await this.profileRepository.query(
      `INSERT INTO reader_profile
         (user_hash, last_collected_at, status, list_count, row_count,
          failure_count, updated_at)
       VALUES ($1, NOW(), $2, $3, $4, $5, NOW())
       ON CONFLICT (user_hash) DO UPDATE SET
         last_collected_at = NOW(),
         status = EXCLUDED.status,
         list_count = EXCLUDED.list_count,
         row_count = EXCLUDED.row_count,
         failure_count = CASE WHEN EXCLUDED.status = 'failed'
                              THEN reader_profile.failure_count + 1
                              ELSE 0 END,
         updated_at = NOW()`,
      [userHash, status, listCount, rowCount, status === 'failed' ? 1 : 0],
    );
  }
}
