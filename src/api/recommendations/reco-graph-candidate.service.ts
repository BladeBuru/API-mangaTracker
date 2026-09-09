import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MangaRecommendation } from '@/api/mangas/manga-recommendation.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { ScoredEntry } from './scored-entry.interface';
import {
  buildGraphSourceContexts,
  GraphLinkRow,
  scoreGraphLinks,
} from './reco-graph-scoring';

/**
 * Injecte le **graphe de voisinage MangaUpdates** (`category` + `related`)
 * dans le pool de candidats du moteur de recommandation.
 *
 * ## Ce que ça répare (constat prod, 2026-09-09)
 *
 * Le pool ne venait que des liens `manual` de MU, complétés — quand il était
 * trop maigre — par le catalogue local trié par genres et note. Or 65 des 77
 * titres de bibliothèque n'avaient AUCUN lien sortant, et les liens
 * existants ciblaient à 84 % des mangas japonais. Un lecteur à 73 % de
 * manhwa recevait donc des mangas : le prorata de type (2026-09-05) ne peut
 * rééquilibrer que ce qui EXISTE dans le pool.
 *
 * `category_recommendations` change la donne parce que ses voisins sont du
 * même univers ET du même format que la source (dérivés des votes de
 * catégorie) : les voisins d'un manhwa sont des manhwa.
 *
 * ## Additif, contrairement au catalogue
 *
 * `CatalogCandidateService` n'additionne jamais son score à une entrée déjà
 * scorée par MU (les recos humaines priment sur une affinité de genres).
 * Ici c'est l'inverse : un titre à la fois recommandé manuellement ET voisin
 * de catégorie ET suite d'une œuvre terminée est un candidat plus fort que
 * chacun de ces signaux isolément — les contributions s'additionnent, comme
 * elles le font déjà entre deux mangas sources du chemin `manual`.
 *
 * Le service ne lève jamais : une panne de cette source ne doit pas priver
 * l'utilisateur des recommandations existantes.
 */
@Injectable()
export class RecoGraphCandidateService {
  private readonly logger = new Logger(RecoGraphCandidateService.name);

  /**
   * Sources interrogées par requête. Au-delà, la clause `IN` devient
   * pathologique ; les bibliothèques réelles font quelques dizaines de
   * titres (68 pour la plus grosse en prod).
   */
  private static readonly SOURCE_BATCH_SIZE = 500;

  constructor(
    @InjectRepository(MangaRecommendation)
    private readonly recoRepository: Repository<MangaRecommendation>,
  ) {}

  /**
   * Ajoute les voisins du graphe au `scoreMap` (mutation en place, comme
   * `scoreRecos`).
   *
   * @returns nombre de candidats INÉDITS ajoutés (les autres ont vu leur
   *   score augmenter), ou 0 si la source est indisponible.
   */
  async augment(
    userMangas: UserManga[],
    excludedMuIds: Set<string>,
    scoreMap: Map<string, ScoredEntry>,
  ): Promise<number> {
    const contexts = buildGraphSourceContexts(userMangas);
    if (contexts.size === 0) return 0;

    let rows: GraphLinkRow[];
    try {
      rows = await this.loadLinks([...contexts.keys()]);
    } catch (err) {
      this.logger.warn(`Graphe de recos indisponible : ${err}`);
      return 0;
    }
    if (rows.length === 0) return 0;

    const contributions = scoreGraphLinks(rows, contexts, excludedMuIds);
    let added = 0;
    for (const contribution of contributions) {
      let entry = scoreMap.get(contribution.muId);
      if (!entry) {
        entry = { score: 0, sources: new Map() };
        scoreMap.set(contribution.muId, entry);
        added += 1;
      }
      entry.score += contribution.score;
      entry.sources.set(
        contribution.sourceMuId,
        (entry.sources.get(contribution.sourceMuId) ?? 0) + contribution.score,
      );
    }

    this.logger.log(
      `Graphe MU : ${contributions.length} lien(s) exploité(s) depuis ` +
        `${contexts.size} œuvre(s) appréciée(s) — ${added} candidat(s) inédit(s), ` +
        `pool=${scoreMap.size}`,
    );
    return added;
  }

  /**
   * Liens `category` et `related` sortants des sources données.
   *
   * `manual` est volontairement EXCLU : ces liens sont déjà consommés, avec
   * leur poids brut, par `RecommendationService.scoreRecos` via
   * `MangasService.getCachedRecommendations`. Les compter deux fois
   * doublerait leur contribution.
   *
   * Requête raw (`getRawMany`) : on ne lit que les cinq colonnes utiles sur
   * un chemin appelé à chaque calcul de recommandations. L'index unique
   * `(source_mu_id, kind, recommended_mu_id)` porte exactement ce filtre.
   */
  private async loadLinks(sourceMuIds: string[]): Promise<GraphLinkRow[]> {
    const rows: GraphLinkRow[] = [];
    for (
      let i = 0;
      i < sourceMuIds.length;
      i += RecoGraphCandidateService.SOURCE_BATCH_SIZE
    ) {
      const batch = sourceMuIds.slice(
        i,
        i + RecoGraphCandidateService.SOURCE_BATCH_SIZE,
      );
      const batchRows = await this.recoRepository
        .createQueryBuilder('mr')
        .select('mr.source_mu_id::text', 'source_mu_id')
        .addSelect('mr.recommended_mu_id::text', 'recommended_mu_id')
        .addSelect('mr.kind', 'kind')
        .addSelect('mr.relation_type', 'relation_type')
        .addSelect('mr.weight', 'weight')
        .where('mr.source_mu_id IN (:...sourceMuIds)', { sourceMuIds: batch })
        .andWhere('mr.kind IN (:...kinds)', { kinds: ['category', 'related'] })
        // `ORDER BY` explicite : sans lui Postgres est libre de rendre les
        // lignes dans n'importe quel ordre, et `scoreCategoryLinks` en
        // tronque 12 par source — le sous-ensemble retenu, donc le pool de
        // candidats, changeait d'une requête à l'autre. L'ordre reproduit
        // celui du tri applicatif (poids décroissant, id croissant).
        .orderBy('mr.source_mu_id', 'ASC')
        .addOrderBy('mr.kind', 'ASC')
        .addOrderBy('mr.weight', 'DESC')
        .addOrderBy('mr.recommended_mu_id', 'ASC')
        .getRawMany<GraphLinkRow>();
      rows.push(
        ...batchRows.map((row) => ({ ...row, weight: Number(row.weight) })),
      );
    }
    return rows;
  }
}
