import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CatalogSyncState } from './catalog-sync-state.entity';
import {
  CatalogShard,
  yearGenreShardJobName,
  yearShardJobName,
} from './catalog-shard';
import { intFromConfig } from './catalog-sync.mapper';
import { MU_SHARDABLE_GENRES } from './constants';

/**
 * Planificateur des shards de catalogue : décide **quoi** synchroniser et
 * **dans quel ordre**. Ne fait aucune I/O — il reçoit les lignes
 * `catalog_sync_state` déjà chargées et retourne une file de shards. Cette
 * pureté est délibérée : la reprise inter-shards et les fenêtres de
 * rafraîchissement sont la partie la plus subtile du système, elles doivent
 * être testables sans mock de repository ni de réseau.
 *
 * ## Pourquoi un découpage par année
 *
 * `total_hits` de `/series/search` est **plafonné à 10 000** quelle que soit
 * la requête (mesuré : page 100 OK, page 200 → 500, page 401 → 400). Une
 * passe globale ne peut donc jamais atteindre plus de 10 000 titres. Découper
 * par année de publication ramène chaque requête sous ce plafond (mesuré avec
 * `exclude_genre` NSFW : 2015 → 4 781 hits, 2024 → 7 124) et rend l'ensemble
 * du catalogue MU atteignable.
 *
 * Le paramètre `letter` a été écarté par la mesure : `{letter:'A'}` sature à
 * 10 000, il ne découpe rien.
 *
 * ## Ordre décroissant (année courante → plancher)
 *
 * La base existante est un top-5 000 par note, biaisé vers les classiques :
 * ce sont les années récentes qui apportent le plus de titres réellement
 * nouveaux, et capter les nouveautés est l'objectif de fond. Le mécanisme de
 * reprise est indifférent au sens de parcours — inverser la boucle de
 * `buildYearShards` suffirait à repasser en ascendant.
 */
@Injectable()
export class CatalogShardPlannerService {
  private readonly logger = new Logger(CatalogShardPlannerService.name);

  /**
   * Plafond de `total_hits` imposé par MU. Une requête qui l'atteint est
   * tronquée : son shard doit être sous-découpé pour rester exhaustif.
   */
  static readonly MU_TOTAL_HITS_CAP = 10_000;

  /**
   * Plancher d'années par défaut. Mesuré le 2026-08-28 : 1925 → 0 hit,
   * 1930 → 1, 1935 → 2, 1950 → 4. Descendre plus bas ne coûterait qu'une
   * requête par année pour zéro titre.
   */
  private static readonly DEFAULT_YEAR_FLOOR = 1930;

  /**
   * Fenêtre de rafraîchissement des shards « chauds » (passes globales,
   * année courante et précédente) : c'est là qu'apparaissent les nouveautés
   * et que les notes bougent encore.
   */
  private static readonly RECENT_REFRESH_DAYS = 7;

  /** Une année est « chaude » si elle est à moins de N ans de l'actuelle. */
  private static readonly RECENT_YEAR_SPAN = 1;

  private static readonly MS_PER_DAY = 24 * 60 * 60 * 1000;

  private readonly yearFloor: number;
  private readonly shardRefreshDays: number;

  constructor(config: ConfigService) {
    this.yearFloor = intFromConfig(
      config,
      'CATALOG_SYNC_YEAR_FLOOR',
      CatalogShardPlannerService.DEFAULT_YEAR_FLOOR,
    );
    this.shardRefreshDays = intFromConfig(
      config,
      'CATALOG_SYNC_SHARD_REFRESH_DAYS',
      30,
    );
  }

  /** Une réponse MU est tronquée dès qu'elle atteint le plafond. */
  static isSaturated(totalHits: number): boolean {
    return totalHits >= CatalogShardPlannerService.MU_TOTAL_HITS_CAP;
  }

  /**
   * File des shards à traiter ce run, dans l'ordre, **shards déjà terminés
   * et encore frais exclus**. C'est ce filtrage qui produit la reprise
   * inter-shards : la nuit N+1 reconstruit la même file, saute tout ce qui
   * est terminé, et tombe donc naturellement sur le shard où la nuit N s'est
   * arrêtée (curseur intact dans `catalog_sync_state`).
   */
  planQueue(states: CatalogSyncState[], now: Date): CatalogShard[] {
    const byName = new Map(states.map((s) => [s.job_name, s]));
    return this.buildAllShards(byName, now).filter((shard) =>
      this.isEligible(shard, byName.get(shard.jobName), now),
    );
  }

  /**
   * Sous-découpe une année saturée en un shard par genre. Limité au niveau 1
   * → 2 : un sous-shard année × genre encore saturé n'est PAS re-découpé
   * (voir `warnStillSaturated`), on se contente des 10 000 titres
   * atteignables plutôt que de partir en récursion.
   */
  expandSaturatedShard(shard: CatalogShard): CatalogShard[] {
    if (shard.level !== 1 || shard.year === undefined) return [];
    return MU_SHARDABLE_GENRES.map((genre) => ({
      jobName: yearGenreShardJobName(shard.year as number, genre),
      kind: 'year_genre' as const,
      level: 2 as const,
      orderby: shard.orderby,
      year: shard.year,
      genre,
    }));
  }

  /**
   * Un shard de niveau 2 encore saturé signale un trou de couverture réel :
   * on ne peut pas descendre plus bas avec les filtres offerts par MU.
   */
  warnStillSaturated(shard: CatalogShard, totalHits: number): void {
    this.logger.warn(
      `[${shard.jobName}] toujours saturé (${totalHits} hits ≥ ${CatalogShardPlannerService.MU_TOTAL_HITS_CAP}) ` +
        'au niveau de découpage maximal (année × genre) — les titres au-delà ' +
        'de la page 100 de ce shard restent hors de portée. Pas de ' +
        'sous-découpage supplémentaire (récursion limitée à 2 niveaux).',
    );
  }

  /**
   * Ordre de parcours : nouveautés hebdo d'abord (dimanche), puis la passe
   * globale, puis les années décroissantes. Une année marquée saturée est
   * immédiatement suivie de ses sous-shards par genre.
   *
   * La passe globale `catalog:rating` est conservée malgré le découpage : les
   * titres dont MU ne connaît pas l'année ne sont atteignables par AUCUN
   * shard annuel, elle est leur seul filet.
   */
  private buildAllShards(
    byName: Map<string, CatalogSyncState>,
    now: Date,
  ): CatalogShard[] {
    const shards: CatalogShard[] = [];

    // Dimanche : top hebdo en tête de file (10 pages, détection de sorties).
    if (now.getDay() === 0) {
      shards.push({
        jobName: 'catalog:week_pos',
        kind: 'global',
        level: 0,
        orderby: 'week_pos',
        pageCap: 10,
      });
    }

    shards.push({
      jobName: 'catalog:rating',
      kind: 'global',
      level: 0,
      orderby: 'rating',
    });

    shards.push(...this.buildYearShards(byName, now));
    return shards;
  }

  /** Années de l'actuelle au plancher, sous-shards des années saturées inclus. */
  private buildYearShards(
    byName: Map<string, CatalogSyncState>,
    now: Date,
  ): CatalogShard[] {
    const shards: CatalogShard[] = [];
    for (let year = now.getFullYear(); year >= this.yearFloor; year--) {
      const shard: CatalogShard = {
        jobName: yearShardJobName(year),
        kind: 'year',
        level: 1,
        orderby: 'rating',
        year,
      };
      shards.push(shard);
      // Saturation constatée lors d'un run précédent : les sous-shards font
      // partie de la file dès la planification, sans attendre une nouvelle
      // détection.
      if (byName.get(shard.jobName)?.saturated) {
        shards.push(...this.expandSaturatedShard(shard));
      }
    }
    return shards;
  }

  /**
   * Un shard est à traiter s'il n'a jamais tourné, s'il est en cours (arrêt
   * sur budget ou incident), ou si sa dernière complétion date de plus que sa
   * fenêtre de rafraîchissement. Un shard terminé et frais est sauté — c'est
   * ce qui évite de tout re-parcourir chaque nuit.
   */
  private isEligible(
    shard: CatalogShard,
    state: CatalogSyncState | undefined,
    now: Date,
  ): boolean {
    if (!state) return true;
    if (state.completed_at === null || state.completed_at === undefined) {
      return true;
    }
    const ageMs = now.getTime() - new Date(state.completed_at).getTime();
    return ageMs >= this.refreshWindowMs(shard, now);
  }

  /** Fenêtre de rafraîchissement d'un shard, en millisecondes. */
  private refreshWindowMs(shard: CatalogShard, now: Date): number {
    const days = this.isHotShard(shard, now)
      ? CatalogShardPlannerService.RECENT_REFRESH_DAYS
      : this.shardRefreshDays;
    return days * CatalogShardPlannerService.MS_PER_DAY;
  }

  /**
   * Shard « chaud » : passes globales et années récentes. Les années
   * anciennes ne bougent quasiment plus — les re-parcourir souvent
   * gaspillerait le budget au détriment des années jamais visitées.
   */
  private isHotShard(shard: CatalogShard, now: Date): boolean {
    if (shard.kind === 'global') return true;
    if (shard.year === undefined) return false;
    const currentYear = now.getFullYear();
    return (
      shard.year >= currentYear - CatalogShardPlannerService.RECENT_YEAR_SPAN
    );
  }
}
