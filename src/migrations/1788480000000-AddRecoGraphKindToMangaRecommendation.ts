import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Graphe de recommandations œuvre-à-œuvre MangaUpdates — modèle de données.
 *
 * ## Constat prod (2026-09-09, lecture seule)
 *
 * `manga_recommendation` ne contenait que **17 825 liens sur 3 812 séries**
 * (2,6 % d'un catalogue de 147 261 titres), tous issus du seul champ
 * `recommendations` de `/v1/series/{id}` — les suggestions manuelles de la
 * communauté. Répartition des cibles par type : 15 007 Manga, 1 345 Manhwa,
 * 190 Manhua. Pour l'utilisateur principal (bibliothèque à 73 % manhwa),
 * **12 titres sur 77** avaient le moindre lien sortant. D'où des
 * recommandations « tout manga » malgré le prorata de type de 2026-09-05.
 *
 * La MÊME réponse MU contient deux autres voisinages jamais ingérés :
 * `category_recommendations` (dérivé des votes de catégorie — le bon
 * voisinage : pour Solo Leveling, *Solo Leveling: Ragnarok*, *I Am the Final
 * Boss*, *I Am the Sorcerer King*) et `related_series` (suites, préquelles,
 * adaptations, avec un `relation_type`).
 *
 * ## Ce que fait cette migration
 *
 * 1. `manga_recommendation.kind` (`varchar(16)` NOT NULL, défaut `'manual'`) —
 *    origine du lien. **Les 17 825 lignes existantes sont marquées `manual`**
 *    par un UPDATE explicite avant la pose du NOT NULL : rien n'est détruit,
 *    le comportement actuel (fiche détail, scoring) est strictement conservé
 *    puisque les lectures historiques filtrent désormais `kind = 'manual'`.
 * 2. `manga_recommendation.relation_type` (`varchar(48)` NULL) — `Sequel`,
 *    `Prequel`, `Spin-Off`, `Adapted From`… uniquement pour `kind='related'`.
 * 3. Unicité : `(source_mu_id, recommended_mu_id)` devient
 *    `(source_mu_id, kind, recommended_mu_id)`. Une même paire peut exister
 *    sous plusieurs origines (une suite est souvent aussi recommandée par
 *    catégorie) et les poids ne sont pas comparables ; l'ancienne contrainte
 *    aurait fait s'écraser les trois signaux l'un l'autre. `kind` en
 *    deuxième position pour que l'index serve aussi la requête du moteur
 *    (« tous les liens `category` de ces sources »).
 * 4. `manga.reco_graph_attempted_at` (`timestamptz` NULL) — filigrane du job
 *    de rattrapage `RecoGraphBackfillService`, même doctrine anti-boucle que
 *    `hydration_attempted_at` (migration `1787875200000`) : une série visitée
 *    ne repasse qu'après la fenêtre de rafraîchissement, ce qui garantit la
 *    progression d'une nuit à l'autre sur 147 261 lignes.
 *
 * Pas d'index sur `reco_graph_attempted_at` : la sélection du job trie par
 * priorité d'usage (`CASE … EXISTS`), un index sur cette seule colonne ne
 * serait pas utilisable — même choix que `hydration_attempted_at`.
 *
 * Additive et idempotente (`hasColumn` / `IF NOT EXISTS`) → sûre avec
 * `migrationsRun: true` en production. `ALTER TABLE … ADD COLUMN` avec défaut
 * ne réécrit pas la table (PostgreSQL ≥ 11) ; la création d'index sur
 * 17 825 lignes est instantanée.
 */
export class AddRecoGraphKindToMangaRecommendation1788480000000
  implements MigrationInterface
{
  name = 'AddRecoGraphKindToMangaRecommendation1788480000000';

  /** Ancienne unicité, remplacée par la variante à trois colonnes. */
  private static readonly LEGACY_UNIQUE_INDEX =
    'IDX_manga_reco_source_recommended_unique';

  private static readonly UNIQUE_INDEX =
    'IDX_manga_reco_source_kind_recommended_unique';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DATABASE_SCHEMA ?? 'public';

    // 1. `kind` — ajoutée nullable puis backfillée puis passée NOT NULL :
    //    l'UPDATE explicite rend la préservation des liens existants visible
    //    et vérifiable, plutôt que de la déléguer au DEFAULT.
    const hasKind = await queryRunner.hasColumn('manga_recommendation', 'kind');
    if (!hasKind) {
      await queryRunner.addColumn(
        'manga_recommendation',
        new TableColumn({
          name: 'kind',
          type: 'varchar',
          length: '16',
          isNullable: true,
          default: "'manual'",
        }),
      );
    }
    await queryRunner.query(
      `UPDATE "${schema}"."manga_recommendation" SET "kind" = 'manual' WHERE "kind" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "${schema}"."manga_recommendation" ALTER COLUMN "kind" SET NOT NULL`,
    );

    // 2. `relation_type` — uniquement pour les liens `related`.
    const hasRelationType = await queryRunner.hasColumn(
      'manga_recommendation',
      'relation_type',
    );
    if (!hasRelationType) {
      await queryRunner.addColumn(
        'manga_recommendation',
        new TableColumn({
          name: 'relation_type',
          type: 'varchar',
          length: '48',
          isNullable: true,
        }),
      );
    }

    // 3. Unicité élargie à `kind`. Le nouvel index est créé AVANT la
    //    suppression de l'ancien : la table n'est jamais sans garde-fou
    //    d'unicité, même si la migration est interrompue entre les deux.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${AddRecoGraphKindToMangaRecommendation1788480000000.UNIQUE_INDEX}" ` +
        `ON "${schema}"."manga_recommendation" ("source_mu_id", "kind", "recommended_mu_id")`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."${AddRecoGraphKindToMangaRecommendation1788480000000.LEGACY_UNIQUE_INDEX}"`,
    );

    // 4. Filigrane du job de rattrapage du graphe.
    const hasAttemptedAt = await queryRunner.hasColumn(
      'manga',
      'reco_graph_attempted_at',
    );
    if (!hasAttemptedAt) {
      await queryRunner.addColumn(
        'manga',
        new TableColumn({
          name: 'reco_graph_attempted_at',
          type: 'timestamptz',
          isNullable: true,
        }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = process.env.DATABASE_SCHEMA ?? 'public';

    const hasAttemptedAt = await queryRunner.hasColumn(
      'manga',
      'reco_graph_attempted_at',
    );
    if (hasAttemptedAt) {
      await queryRunner.dropColumn('manga', 'reco_graph_attempted_at');
    }

    // Retour à l'unicité (source, cible) : les liens `category` / `related`
    // doivent disparaître d'abord, sinon la contrainte historique ne peut
    // pas être recréée (plusieurs lignes par paire).
    await queryRunner.query(
      `DELETE FROM "${schema}"."manga_recommendation" WHERE "kind" <> 'manual'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${AddRecoGraphKindToMangaRecommendation1788480000000.LEGACY_UNIQUE_INDEX}" ` +
        `ON "${schema}"."manga_recommendation" ("source_mu_id", "recommended_mu_id")`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."${AddRecoGraphKindToMangaRecommendation1788480000000.UNIQUE_INDEX}"`,
    );

    const hasRelationType = await queryRunner.hasColumn(
      'manga_recommendation',
      'relation_type',
    );
    if (hasRelationType) {
      await queryRunner.dropColumn('manga_recommendation', 'relation_type');
    }

    const hasKind = await queryRunner.hasColumn('manga_recommendation', 'kind');
    if (hasKind) {
      await queryRunner.dropColumn('manga_recommendation', 'kind');
    }
  }
}
