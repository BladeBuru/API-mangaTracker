import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Manga } from './manga.entity';
import { MangaRecommendation } from './manga-recommendation.entity';
import {
  mapSeriesNeighbourhood,
  MuNeighbourLink,
  MuRelatedLink,
  RecoLinkKind,
} from './reco-graph.mapper';

/** Bilan d'une ingestion, pour les logs, le job de rattrapage et les tests. */
export interface RecoGraphIngestOutcome {
  manual: number;
  category: number;
  related: number;
  /** Lignes `manga` créées en stub pour des cibles encore inconnues. */
  stubs: number;
}

/** Ligne prête pour l'upsert `manga_recommendation`. */
interface LinkRow {
  source_mu_id: string;
  recommended_mu_id: string;
  recommended_title: string | null;
  kind: RecoLinkKind;
  relation_type: string | null;
  weight: number;
}

/**
 * **Écriture** du graphe de voisinage MangaUpdates : reçoit une réponse
 * `/v1/series/{id}` déjà téléchargée et persiste les trois voisinages.
 *
 * ## Coût réseau nul (2026-09-09)
 *
 * Ce service n'appelle JAMAIS MangaUpdates. Il se branche sur des réponses
 * que l'API récupère déjà :
 *  - `MangasService.getMangaDetails` — chemin chaud (ouverture d'une fiche)
 *    ET les 800 fiches par nuit de `CatalogHydrationService`, qui l'appelle
 *    en boucle ; ces réponses contenaient déjà les trois champs de voisinage,
 *    on ne lisait que le premier ;
 *  - `MangasService.fetchAndCacheRecommendations` — même endpoint ;
 *  - `RecoGraphBackfillService` — le seul appelant qui télécharge pour ce
 *    graphe, sur un budget nocturne dédié.
 *
 * Service séparé plutôt que du code de plus dans `MangasService` : la
 * responsabilité (« écrire le graphe ») est distincte de « servir une fiche
 * manga », elle a ses propres tests, et `MangasService` frôlait déjà la
 * limite de 600 lignes du repo.
 *
 * ## Idempotence
 *
 * Tout passe par des upserts : `ON CONFLICT (mu_id) DO NOTHING` pour les
 * stubs (on n'écrase jamais une fiche complète) et
 * `ON CONFLICT (source_mu_id, kind, recommended_mu_id) DO UPDATE` pour les
 * liens. Réingérer la même fiche deux fois ne crée aucune ligne en double et
 * ne détruit aucun lien d'une autre origine.
 */
@Injectable()
export class RecoGraphIngestService {
  private readonly logger = new Logger(RecoGraphIngestService.name);

  /** Colonnes rafraîchies quand un lien existe déjà. */
  private static readonly UPSERT_COLUMNS = [
    'recommended_title',
    'relation_type',
    'weight',
    'updated_at',
  ];

  /** Colonnes de la contrainte d'unicité (migration `1788480000000`). */
  private static readonly CONFLICT_COLUMNS = [
    'source_mu_id',
    'kind',
    'recommended_mu_id',
  ];

  constructor(
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    @InjectRepository(MangaRecommendation)
    private readonly recoRepository: Repository<MangaRecommendation>,
  ) {}

  /**
   * Extrait et persiste les trois voisinages d'une fiche MU.
   *
   * @param sourceMuId `mu_id` de la série dont on a lu la fiche.
   * @param payload    Corps brut de la réponse `/v1/series/{id}`.
   */
  async ingestSeriesPayload(
    sourceMuId: number,
    payload: unknown,
  ): Promise<RecoGraphIngestOutcome> {
    const neighbourhood = mapSeriesNeighbourhood(sourceMuId, payload);
    const outcome: RecoGraphIngestOutcome = {
      manual: 0,
      category: 0,
      related: 0,
      stubs: 0,
    };

    outcome.stubs = await this.ensureStubs([
      ...neighbourhood.manual,
      ...neighbourhood.category,
      ...neighbourhood.related,
    ]);
    await this.backfillCovers([
      ...neighbourhood.manual,
      ...neighbourhood.category,
    ]);

    outcome.manual = await this.saveWeightedLinks(
      sourceMuId,
      'manual',
      neighbourhood.manual,
    );
    outcome.category = await this.saveWeightedLinks(
      sourceMuId,
      'category',
      neighbourhood.category,
    );
    outcome.related = await this.saveRelatedLinks(
      sourceMuId,
      neighbourhood.related,
    );

    // Le `type` de la série SOURCE est dans la même réponse et ne coûte rien.
    // Il est la clé du prorata de type des recommandations : un voisin sans
    // type tombe dans le seau « inconnu », pénalisé quand la préférence de
    // l'utilisateur est marquée. Écriture null-safe (jamais d'écrasement par
    // NULL), même doctrine que `PROTECTED_NULLABLE_COLUMNS`.
    await this.persistSourceType(sourceMuId, neighbourhood.sourceType);

    return outcome;
  }

  /**
   * Upsert des liens `manual` seuls — chemin historique conservé pour
   * `MangasService.saveRecommendations` (fiche détail, `hidden_gems`).
   */
  async saveManualLinks(
    sourceMuId: number,
    links: MuNeighbourLink[],
  ): Promise<number> {
    if (links.length === 0) return 0;
    await this.ensureStubs(links);
    await this.backfillCovers(links);
    return this.saveWeightedLinks(sourceMuId, 'manual', links);
  }

  /**
   * Crée les lignes `manga` manquantes pour les cibles (mu_id + titre, et les
   * covers quand MU les fournit). Sans ce stub, la cible serait filtrée
   * silencieusement de `buildDtoFromScoreMap` (cf. migration `1746230800000`).
   *
   * `ON CONFLICT (mu_id) DO NOTHING` : une fiche déjà complète n'est jamais
   * écrasée. En prod, 100 % des cibles du graphe existent déjà dans `manga`
   * (mesuré le 2026-09-09) — cet appel est donc un no-op dans l'immense
   * majorité des cas, mais il reste la garantie qu'un titre tout neuf côté MU
   * ne casse pas la carte.
   *
   * @returns nombre de cibles distinctes présentées à l'insert.
   */
  private async ensureStubs(
    links: (MuNeighbourLink | MuRelatedLink)[],
  ): Promise<number> {
    const byId = new Map<number, MuNeighbourLink | MuRelatedLink>();
    for (const link of links) {
      const existing = byId.get(link.seriesId);
      // Une entrée porteuse de cover l'emporte sur une entrée `related` nue.
      if (
        !existing ||
        (!('smallCoverUrl' in existing) && 'smallCoverUrl' in link)
      ) {
        byId.set(link.seriesId, link);
      }
    }
    if (byId.size === 0) return 0;

    await this.mangaRepository
      .createQueryBuilder()
      .insert()
      .into(Manga)
      .values(
        [...byId.values()].map((link) => ({
          mu_id: link.seriesId.toString(),
          title: link.title || `Manga ${link.seriesId}`,
          small_cover_url:
            'smallCoverUrl' in link ? link.smallCoverUrl ?? null : null,
          medium_cover_url:
            'mediumCoverUrl' in link ? link.mediumCoverUrl ?? null : null,
        })),
      )
      .orIgnore()
      .execute();

    return byId.size;
  }

  /**
   * Complète les covers des stubs déjà créés SANS image (héritage des
   * ingestions antérieures à la lecture de `series_image`) — jamais les
   * fiches qui en ont déjà une. Un seul UPDATE ensembliste par lot, là où le
   * code d'origine faisait une requête par recommandation.
   */
  private async backfillCovers(links: MuNeighbourLink[]): Promise<void> {
    const withCover = links.filter((link) => link.mediumCoverUrl);
    for (const link of withCover) {
      await this.mangaRepository
        .createQueryBuilder()
        .update(Manga)
        .set({
          small_cover_url: link.smallCoverUrl ?? null,
          medium_cover_url: link.mediumCoverUrl ?? null,
        })
        .where('mu_id = :muId', { muId: link.seriesId.toString() })
        .andWhere('medium_cover_url IS NULL')
        .execute();
    }
  }

  /** Upsert d'un lot de liens pondérés (`manual` ou `category`). */
  private async saveWeightedLinks(
    sourceMuId: number,
    kind: RecoLinkKind,
    links: MuNeighbourLink[],
  ): Promise<number> {
    const rows: LinkRow[] = links.map((link) => ({
      source_mu_id: sourceMuId.toString(),
      recommended_mu_id: link.seriesId.toString(),
      recommended_title: link.title || null,
      kind,
      relation_type: null,
      weight: link.weight,
    }));
    return this.upsertLinks(rows);
  }

  /**
   * Upsert des liens de parenté. Le poids MU n'existe pas pour ce champ :
   * on stocke `0` et l'information utile va dans `relation_type`. Les
   * relations « même œuvre, autre support » (`Adapted From`…) sont
   * conservées telles quelles — c'est le SCORING qui les écarte, pas le
   * stockage : le jour où l'on voudra proposer le roman d'un manhwa, la
   * donnée sera déjà là sans re-télécharger le graphe.
   */
  private async saveRelatedLinks(
    sourceMuId: number,
    links: MuRelatedLink[],
  ): Promise<number> {
    const rows: LinkRow[] = links.map((link) => ({
      source_mu_id: sourceMuId.toString(),
      recommended_mu_id: link.seriesId.toString(),
      recommended_title: link.title || null,
      kind: 'related' as const,
      relation_type: link.relationType,
      weight: 0,
    }));
    return this.upsertLinks(rows);
  }

  /** INSERT multi-lignes + `ON CONFLICT DO UPDATE` (une requête par lot). */
  private async upsertLinks(rows: LinkRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    await this.recoRepository
      .createQueryBuilder()
      .insert()
      .into(MangaRecommendation)
      .values(rows)
      .orUpdate(
        RecoGraphIngestService.UPSERT_COLUMNS,
        RecoGraphIngestService.CONFLICT_COLUMNS,
      )
      .execute();
    return rows.length;
  }

  /** Écrit `manga.type` de la source si MU le fournit et qu'il manque. */
  private async persistSourceType(
    sourceMuId: number,
    sourceType: string | null,
  ): Promise<void> {
    if (!sourceType) return;
    try {
      await this.mangaRepository
        .createQueryBuilder()
        .update(Manga)
        .set({ type: sourceType })
        .where('mu_id = :muId', { muId: sourceMuId.toString() })
        .andWhere('type IS NULL')
        .execute();
    } catch (err) {
      this.logger.warn(
        `Type de la source mu_id=${sourceMuId} non persisté : ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }
}
