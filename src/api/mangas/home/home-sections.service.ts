import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MangaQuickViewDto } from '../dto/manga-quick-view.dto';
import { Manga } from '../manga.entity';
import {
  HomeSectionDto,
  HomeSectionPageDto,
  HomeSectionsResponseDto,
  HOME_DEFAULT_LIMIT,
} from './dto/home-sections.dto';
import {
  buildHomeSectionDefs,
  HomeSectionDef,
  MIN_SECTION_ITEMS,
  parseHomeSectionId,
} from './home-section.catalog';
import { HomeSectionQueryBuilder } from './home-sections.query';

/** Entrée de cache : valeur + horodatage de construction. */
interface CacheEntry<T> {
  value: T;
  builtAt: number;
}

/**
 * Accueil « façon Netflix » : `GET /mangas/home/sections` (toutes les
 * sections, `limit` titres chacune) et `GET /mangas/home/sections/:id`
 * (une section paginée). Lecture BDD uniquement, aucun appel MangaUpdates.
 *
 * ## Performance (< 300 ms)
 *
 * - Toutes les sections sont interrogées **en parallèle** (pool pg), puis
 *   dédupliquées en mémoire dans l'ordre serveur ;
 * - cache mémoire ~10 min par variante (`home:<limit>`,
 *   `section:<id>:<page>:<limit>`), **stale-while-revalidate** : une entrée
 *   périmée est servie immédiatement et reconstruite en tâche de fond —
 *   après le premier appel, la réponse ne dépend plus jamais de la BDD ;
 * - préchauffage de la variante par défaut 15 s après le démarrage.
 *
 * ## Déduplication inter-sections (accueil uniquement)
 *
 * Un titre n'apparaît que dans la PREMIÈRE section qui le sélectionne, dans
 * l'ordre de `buildHomeSectionDefs`. Chaque section est d'abord chargée avec
 * une surcharge ×3 (en parallèle) ; si les retraits la laissent sous `limit`,
 * les pages suivantes de SA requête sont lues jusqu'à `limit` titres uniques
 * ou épuisement (au plus `MAX_EXTRA_PAGES`). Sans cela, les sections de fin
 * (`hidden_gems`) seraient affamées : `popular`, `top_rated`, les types et
 * les genres consomment ensemble les ~200 meilleures notes du catalogue.
 * Les pages de détail (`/sections/:id`) ne dédupliquent pas : elles sont
 * autonomes et paginées, la première page d'une section peut donc différer
 * de son extrait sur l'accueil — c'est documenté dans le contrat.
 *
 * Une section qui échoue (SQL) est loggée et omise ; une section de moins de
 * `MIN_SECTION_ITEMS` (5) titres est omise — tant que `manga.type` n'est pas
 * rattrapé, les sections `type:*` peuvent donc manquer.
 */
@Injectable()
export class HomeSectionsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(HomeSectionsService.name);

  /** Durée de fraîcheur d'une entrée de cache. */
  static readonly CACHE_TTL_MS = 10 * 60 * 1000;

  /** Surcharge par section sur l'accueil (compense la déduplication). */
  private static readonly OVERFETCH_FACTOR = 3;
  private static readonly OVERFETCH_MAX = 120;

  /** Pages supplémentaires max lues pour compléter une section déficitaire. */
  private static readonly MAX_EXTRA_PAGES = 4;

  /** Délai de préchauffage après le démarrage. */
  private static readonly WARMUP_DELAY_MS = 15_000;

  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly refreshing = new Set<string>();
  private readonly warmupEnabled: boolean;

  /** Injectable pour les tests (horloge). */
  now: () => Date = () => new Date();

  constructor(
    private readonly queries: HomeSectionQueryBuilder,
    config: ConfigService,
  ) {
    this.warmupEnabled = config.get<string>('NODE_ENV') !== 'test';
  }

  onApplicationBootstrap(): void {
    if (!this.warmupEnabled) return;
    const timer = setTimeout(() => {
      this.getHome(HOME_DEFAULT_LIMIT).catch((err) =>
        this.logger.warn(
          `Préchauffage de l'accueil en échec : ${
            (err as Error)?.message ?? err
          }`,
        ),
      );
    }, HomeSectionsService.WARMUP_DELAY_MS);
    timer.unref?.();
  }

  /** Toutes les sections de l'accueil (`limit` titres chacune). */
  getHome(limit: number): Promise<HomeSectionsResponseDto> {
    return this.cached(`home:${limit}`, () => this.buildHome(limit));
  }

  /** Une section paginée. 404 si l'`id` est inconnu. */
  async getSection(
    id: string,
    page: number,
    limit: number,
  ): Promise<HomeSectionPageDto> {
    const def = parseHomeSectionId(id, this.now());
    if (!def) throw new NotFoundException(`Unknown home section '${id}'`);
    return this.cached(`section:${def.id}:${page}:${limit}`, () =>
      this.buildSectionPage(def, page, limit),
    );
  }

  private async buildHome(limit: number): Promise<HomeSectionsResponseDto> {
    const now = this.now();
    const defs = buildHomeSectionDefs(now);
    const fetchLimit = Math.min(
      limit * HomeSectionsService.OVERFETCH_FACTOR,
      HomeSectionsService.OVERFETCH_MAX,
    );
    const candidates = await Promise.all(
      defs.map((def) => this.fetchCandidates(def, now, fetchLimit, 0)),
    );

    const displayed = new Set<string>();
    const sections: HomeSectionDto[] = [];
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      let rows = candidates[i];
      if (!rows) continue;
      const items: MangaQuickViewDto[] = [];
      let extraPages = 0;
      // Pages suivantes tant que la déduplication laisse la section sous
      // `limit` et que la requête a encore des lignes (page pleine).
      for (;;) {
        for (const manga of rows) {
          if (items.length >= limit) break;
          if (displayed.has(manga.mu_id)) continue;
          if (items.some((it) => String(it.muId) === manga.mu_id)) continue;
          items.push(MangaQuickViewDto.fromCatalog(manga));
        }
        const exhausted = rows.length < fetchLimit;
        if (
          items.length >= limit ||
          exhausted ||
          extraPages >= HomeSectionsService.MAX_EXTRA_PAGES
        ) {
          break;
        }
        extraPages += 1;
        const more = await this.fetchCandidates(
          def,
          now,
          fetchLimit,
          extraPages * fetchLimit,
        );
        if (!more || more.length === 0) break;
        rows = more;
      }
      if (items.length < MIN_SECTION_ITEMS) continue;
      for (const item of items) displayed.add(String(item.muId));
      sections.push({ id: def.id, kind: def.kind, params: def.params, items });
    }

    return { generatedAt: now.toISOString(), sections };
  }

  /** Lignes d'une section, `null` en cas d'erreur SQL (section omise). */
  private async fetchCandidates(
    def: HomeSectionDef,
    now: Date,
    limit: number,
    offset: number,
  ): Promise<Manga[] | null> {
    try {
      return await this.queries
        .build(def, now)
        .offset(offset)
        .limit(limit)
        .getMany();
    } catch (err) {
      this.logger.warn(
        `Section « ${def.id} » indisponible : ${
          (err as Error)?.message ?? err
        }`,
      );
      return null;
    }
  }

  private async buildSectionPage(
    def: HomeSectionDef,
    page: number,
    limit: number,
  ): Promise<HomeSectionPageDto> {
    const now = this.now();
    const query = this.queries.build(def, now);
    const [rows, total] = await Promise.all([
      query
        .clone()
        .offset((page - 1) * limit)
        .limit(limit)
        .getMany(),
      query.getCount(),
    ]);
    return {
      id: def.id,
      kind: def.kind,
      params: def.params,
      page,
      limit,
      total,
      items: rows.map((manga) => MangaQuickViewDto.fromCatalog(manga)),
    };
  }

  /**
   * Cache mémoire stale-while-revalidate : entrée fraîche → servie ; périmée
   * → servie telle quelle et reconstruite en arrière-plan (une seule
   * reconstruction à la fois par clé) ; absente → construite en ligne.
   */
  private async cached<T>(key: string, build: () => Promise<T>): Promise<T> {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    const nowMs = this.now().getTime();
    if (entry) {
      const stale = nowMs - entry.builtAt >= HomeSectionsService.CACHE_TTL_MS;
      if (stale && !this.refreshing.has(key)) {
        this.refreshing.add(key);
        build()
          .then((value) => this.cache.set(key, { value, builtAt: nowMs }))
          .catch((err) =>
            this.logger.warn(
              `Rafraîchissement « ${key} » en échec, ancienne valeur conservée : ${
                (err as Error)?.message ?? err
              }`,
            ),
          )
          .finally(() => this.refreshing.delete(key));
      }
      return entry.value;
    }
    const value = await build();
    this.cache.set(key, { value, builtAt: nowMs });
    return value;
  }
}
