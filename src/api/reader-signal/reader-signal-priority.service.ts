import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogSyncState } from '@/api/mangas/catalog-sync-state.entity';
import { Manga } from '@/api/mangas/manga.entity';

/** Préfixe des lignes `catalog_sync_state` appartenant à ce module. */
export const READER_SIGNAL_STATE_PREFIX = 'reader-signal';

/** Nom du seau « bibliothèques utilisateurs ». */
export const LIBRARY_BUCKET = 'library';

/**
 * Types d'œuvre échantillonnés à part égale par la découverte.
 *
 * L'ordre compte : c'est celui du round-robin, donc celui qui est servi en
 * premier quand le budget ne suffit pas pour un tour complet. Manhwa et
 * manhua d'abord — c'est le point faible du produit (un lecteur de manhwa ne
 * recevait que des mangas) et leur longue traîne est plus pauvre, donc
 * chaque nuit y compte davantage.
 */
export const DISCOVERY_TYPES = ['Manhwa', 'Manhua', 'Manga'] as const;

/** Une série à sonder, avec le seau qui l'a produite. */
export interface DiscoveryTarget {
  muId: string;
  /** `manga.type`, ou `null` si inconnu (possible via la bibliothèque). */
  mangaType: string | null;
  /** Seau d'origine : `library` ou l'un de `DISCOVERY_TYPES`. */
  bucket: string;
}

/** Curseur d'un seau, tel que persisté dans `catalog_sync_state`. */
export interface BucketCursor {
  bucket: string;
  offset: number;
  /** Profondeur configurée du seau (rang maximal exploré). */
  depth: number;
  /** `true` si le seau a rendu moins de lignes que demandé → fin de passe. */
  exhausted: boolean;
}

/**
 * Exclusion NSFW, paramétrée pour rester identique entre les requêtes de
 * ciblage et le focus set d'agrégation.
 *
 * `json_array_elements_text` plutôt que l'opérateur `jsonb ?|` : la colonne
 * `manga.genres` est de type `json` (pas `jsonb`), et `?` reste un caractère
 * piégeux à trimballer dans une requête paramétrée. Une ligne sans genres
 * (`NULL`) est conservée — « genres inconnus » n'est pas « NSFW ».
 */
export function nsfwFilterSql(alias: string, param: string): string {
  return (
    `(${alias}.genres IS NULL OR NOT EXISTS (` +
    `SELECT 1 FROM json_array_elements_text(${alias}.genres) g ` +
    `WHERE g = ANY(${param})))`
  );
}

/**
 * Choisit QUELLES séries la découverte va sonder, et dans quel ordre.
 *
 * ## Pourquoi ne pas parcourir les 147 261 séries
 *
 * Le signal est concentré sur la tête du catalogue. Mesuré le 2026-09-09 sur
 * `/lists/similar/complete` : les têtes de chaque type saturent le plafond
 * MU (100 lecteurs), tandis qu'un manhwa tiré au hasard en ramène ~3,5 dont
 * ~2,2 notés. Sonder la longue traîne coûterait 5 requêtes par série pour
 * presque rien. On cible donc la tête, et **on rééquilibre par type** : à
 * note égale le catalogue est massivement japonais (70 524 manga contre
 * 13 791 manhwa et 11 150 manhua), un simple `ORDER BY rating` ne produirait
 * quasiment que du manga — exactement le biais qu'on cherche à corriger.
 *
 * ## Deux sources, dans cet ordre
 *
 * 1. **Bibliothèques utilisateurs** (`user_manga`) — les titres que nos
 *    comptes suivent réellement. Ce sont les seuls depuis lesquels le moteur
 *    aura à recommander dès demain : leur voisinage doit être dense d'abord.
 * 2. **Tête de chaque type**, en round-robin à part égale.
 *
 * Chaque seau a son curseur persistant (`catalog_sync_state`, lignes
 * `reader-signal:disc:<seau>`), à l'image des shards du catalogue. Un seau
 * épuisé repart à 0 : les lecteurs changent (comptes créés depuis), et les
 * lignes déjà vues sont réécrites idempotemment.
 */
@Injectable()
export class ReaderSignalPriorityService {
  private readonly logger = new Logger(ReaderSignalPriorityService.name);

  constructor(
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    @InjectRepository(CatalogSyncState)
    private readonly stateRepository: Repository<CatalogSyncState>,
  ) {}

  /** Nom de la ligne `catalog_sync_state` d'un seau. */
  static stateName(bucket: string): string {
    return `${READER_SIGNAL_STATE_PREFIX}:disc:${bucket}`;
  }

  /**
   * Construit la file de séries à sonder pour la nuit.
   *
   * @param seriesBudget Nombre de séries que le budget de la nuit autorise.
   * @param depthPerType Profondeur d'un seau de type (rang max exploré).
   * @param nsfwGenres   Genres exclus du ciblage.
   */
  async buildQueue(
    seriesBudget: number,
    depthPerType: number,
    nsfwGenres: readonly string[],
  ): Promise<{ targets: DiscoveryTarget[]; cursors: BucketCursor[] }> {
    if (seriesBudget <= 0) return { targets: [], cursors: [] };

    const cursors: BucketCursor[] = [];
    const perBucket: DiscoveryTarget[][] = [];

    // Le seau bibliothèque est servi EN PREMIER et en entier tant qu'il
    // reste du budget : c'est le voisinage dont le produit a besoin demain.
    const libState = await this.readCursor(LIBRARY_BUCKET, seriesBudget);
    const libTargets = await this.fetchLibraryTargets(
      libState.offset,
      seriesBudget,
    );
    libState.exhausted = libTargets.length < seriesBudget;
    cursors.push(libState);
    perBucket.push(libTargets);

    const remaining = seriesBudget - libTargets.length;
    if (remaining > 0) {
      // Chaque seau est lu jusqu'à `remaining`, PAS jusqu'à sa part
      // théorique : c'est le round-robin qui répartit ensuite. Servir
      // `remaining / 3` à chacun laisserait du budget dormir dès qu'un type
      // est plus court que sa part (le manhua s'épuise avant le manga), et
      // le sur-tirage ne coûte que des lignes lues, jamais une requête MU.
      for (const mangaType of DISCOVERY_TYPES) {
        const cursor = await this.readCursor(mangaType, depthPerType);
        const take = Math.max(
          0,
          Math.min(remaining, depthPerType - cursor.offset),
        );
        const targets = await this.fetchTypeTargets(
          mangaType,
          cursor.offset,
          take,
          nsfwGenres,
        );
        cursor.exhausted = targets.length < take;
        cursors.push(cursor);
        perBucket.push(targets);
      }
    }

    return { targets: interleave(perBucket, seriesBudget), cursors };
  }

  /**
   * Avance le curseur d'un seau de `consumed` séries.
   *
   * Retour à 0 dès que le seau est épuisé (moins de lignes que demandé) ou
   * que sa profondeur est atteinte : sans cette remise à zéro, un seau plus
   * court que sa profondeur configurée (la bibliothèque, ~87 titres pour une
   * profondeur de plusieurs centaines) se figerait sur un offset au-delà de
   * son contenu et ne rendrait plus jamais rien.
   */
  async advanceCursor(cursor: BucketCursor, consumed: number): Promise<void> {
    if (consumed <= 0 && !cursor.exhausted) return;
    const name = ReaderSignalPriorityService.stateName(cursor.bucket);
    const next = cursor.offset + consumed;
    const wrapped = cursor.exhausted || next >= cursor.depth;
    const state =
      (await this.stateRepository.findOneBy({ job_name: name })) ??
      this.stateRepository.create({ job_name: name });
    state.last_completed_page = wrapped ? 0 : next;
    state.total_pages = cursor.depth;
    state.last_run_at = new Date();
    state.last_run_status = wrapped ? 'completed' : 'partial';
    if (wrapped) {
      state.completed_at = new Date();
      this.logger.log(
        `[reader-signal] seau « ${cursor.bucket} » bouclé (rang ${next}) — ` +
          'reprise au rang 0 au prochain run',
      );
    }
    await this.stateRepository.save(state);
  }

  /**
   * Titres présents dans au moins une bibliothèque utilisateur, les plus
   * suivis d'abord (un titre partagé par 4 comptes vaut mieux qu'un titre
   * isolé), puis `mu_id` pour un ordre total stable d'une nuit à l'autre.
   */
  private async fetchLibraryTargets(
    offset: number,
    limit: number,
  ): Promise<DiscoveryTarget[]> {
    if (limit <= 0) return [];
    const rows: TargetRow[] = await this.mangaRepository.query(
      `SELECT m.mu_id::text AS mu_id, m.type
         FROM user_manga um
         JOIN manga m ON m.mu_id = um.manga_id
        GROUP BY m.mu_id, m.type
        ORDER BY COUNT(*) DESC, m.mu_id
        OFFSET $1 LIMIT $2`,
      [offset, limit],
    );
    return toTargets(rows, LIBRARY_BUCKET);
  }

  /** Tête d'un type, par note décroissante, NSFW exclus. */
  private async fetchTypeTargets(
    mangaType: string,
    offset: number,
    limit: number,
    nsfwGenres: readonly string[],
  ): Promise<DiscoveryTarget[]> {
    if (limit <= 0) return [];
    const rows: TargetRow[] = await this.mangaRepository.query(
      `SELECT m.mu_id::text AS mu_id, m.type
         FROM manga m
        WHERE m.type = $1
          AND m.rating IS NOT NULL
          AND ${nsfwFilterSql('m', '$4')}
        ORDER BY m.rating DESC, m.mu_id
        OFFSET $2 LIMIT $3`,
      [mangaType, offset, limit, [...nsfwGenres]],
    );
    return toTargets(rows, mangaType);
  }

  private async readCursor(
    bucket: string,
    depth: number,
  ): Promise<BucketCursor> {
    const name = ReaderSignalPriorityService.stateName(bucket);
    const state = await this.stateRepository.findOneBy({ job_name: name });
    const offset = Number(state?.last_completed_page ?? 0);
    return {
      bucket,
      offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
      depth,
      exhausted: false,
    };
  }
}

/** Ligne brute renvoyée par les requêtes de ciblage. */
interface TargetRow {
  mu_id: string;
  type: string | null;
}

function toTargets(rows: TargetRow[], bucket: string): DiscoveryTarget[] {
  return (rows ?? []).map((row) => ({
    muId: String(row.mu_id),
    mangaType: row.type ?? null,
    bucket,
  }));
}

/**
 * Entrelace les seaux en round-robin, en préservant l'ordre interne.
 *
 * C'est ce qui garantit l'équilibre par type même quand le budget est coupé
 * en cours de route : si la nuit s'arrête à 12 sondes, on a 4 manhwa,
 * 4 manhua et 4 manga, jamais 12 manga. Un seau épuisé est simplement sauté,
 * les autres se partagent le reste plutôt que de laisser du budget dormir.
 */
export function interleave(
  buckets: DiscoveryTarget[][],
  limit: number,
): DiscoveryTarget[] {
  const out: DiscoveryTarget[] = [];
  const cursors = buckets.map(() => 0);
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (let i = 0; i < buckets.length && out.length < limit; i++) {
      const bucket = buckets[i];
      if (cursors[i] >= bucket.length) continue;
      out.push(bucket[cursors[i]++]);
      progressed = true;
    }
  }
  return out;
}
