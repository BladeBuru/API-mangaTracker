/**
 * Mesure AVANT / APRÈS du graphe de recommandations MangaUpdates.
 *
 *   npm run measure:reco-graph -- --user=1
 *
 * Répond avec des chiffres à la seule question qui compte : **est-ce que ça
 * règle le problème des recommandations trop manga ?**
 *
 * ## Ce qui est comparé
 *
 * - **AVANT** : le pipeline actuel — liens `manual` de `manga_recommendation`
 *   scorés comme en production (`weight × statut × note × récence`), complétés
 *   par les candidats du catalogue local (le VRAI `CatalogCandidateService`,
 *   buckets de type compris) quand le pool passe sous 150.
 * - **APRÈS** : le même pool, plus les voisins `category` / `related`
 *   normalisés par `scoreGraphLinks`.
 *
 * Les deux pools passent ensuite par `interleaveByTypeMix` avec le profil de
 * type réel de la bibliothèque — exactement ce que fait
 * `RecommendationDtoBuilderService`. On imprime la répartition par type du
 * pool ET du top N servi à l'écran.
 *
 * ## Base de production en LECTURE SEULE
 *
 * Le script n'ouvre que des SELECT (TypeORM `synchronize: false`, aucune
 * migration, aucun `save`). Rien n'est écrit, ni dans `manga`, ni dans
 * `manga_recommendation`.
 *
 * ## Deux sources pour le graphe
 *
 * - `--live` (défaut) : les voisinages sont lus à chaud sur
 *   `GET /v1/series/{id}` pour les titres de la bibliothèque, à **1 requête /
 *   2 s** (la cadence du projet), et mis en cache sur disque pour que les
 *   re-runs ne recoûtent rien. C'est le mode à utiliser AVANT le déploiement,
 *   quand la table ne contient encore aucun lien `category`.
 *   ⚠️ À lancer hors des créneaux nocturnes (01:00 / 02:00 / 03:30 / 07:00) :
 *   ce script ne prend pas le verrou `MuJobLockService`.
 * - `--db` : les voisinages sont lus dans `manga_recommendation`. C'est le
 *   mode à utiliser APRÈS quelques nuits de rattrapage, pour mesurer l'effet
 *   réel en production.
 *
 * Options : `--user=<id>` (défaut 1), `--top=<n>` (défaut 30),
 * `--cache=<chemin>`, `--db`, `--live`.
 */
import 'reflect-metadata';
import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { Manga } from '../src/api/mangas/manga.entity';
import { MangaRecommendation } from '../src/api/mangas/manga-recommendation.entity';
import { UserManga } from '../src/api/mangas/user-manga.entity';
import { MU_DETAIL_URL } from '../src/api/mangas/constants';
import { mapSeriesNeighbourhood } from '../src/api/mangas/reco-graph.mapper';
import { CatalogCandidateService } from '../src/api/recommendations/catalog-candidate.service';
import {
  buildGraphSourceContexts,
  GraphLinkRow,
  scoreGraphLinks,
} from '../src/api/recommendations/reco-graph-scoring';
import { ScoredEntry } from '../src/api/recommendations/scored-entry.interface';
import {
  computeTypeProfile,
  interleaveByTypeMix,
} from '../src/api/recommendations/type-profile';

/** Miroir de `RecommendationService`. */
const STATUS_MULTIPLIER: Record<string, number> = {
  completed: 1.5,
  caughtUp: 1.3,
  reading: 1.2,
  readLater: 0.8,
};
const RECENCY_HALF_LIFE_DAYS = 365;
const MAX_RECOS_PER_SOURCE = 40;
const CATALOG_MIN_POOL = 150;
const MU_DELAY_MS = 2000;

interface Options {
  userId: number;
  top: number;
  live: boolean;
  cachePath: string;
}

function parseOptions(argv: string[]): Options {
  const value = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  return {
    userId: Number(value('user') ?? 1),
    top: Number(value('top') ?? 30),
    live: !argv.includes('--db'),
    cachePath:
      value('cache') ?? path.join(os.tmpdir(), 'reco-graph-mu-cache.json'),
  };
}

function multiplierOf(um: UserManga): number {
  const rating = Number(um.user_rating) || 0;
  const ageDays = (Date.now() - um.adding_date.getTime()) / 86_400_000;
  return (
    (rating > 0 ? rating / 5.0 : 1.0) *
    (STATUS_MULTIPLIER[um.readingStatus] ?? 1.0) *
    Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS)
  );
}

function addContribution(
  scoreMap: Map<string, ScoredEntry>,
  muId: string,
  sourceMuId: string,
  score: number,
): void {
  let entry = scoreMap.get(muId);
  if (!entry) {
    entry = { score: 0, sources: new Map() };
    scoreMap.set(muId, entry);
  }
  entry.score += score;
  entry.sources.set(sourceMuId, (entry.sources.get(sourceMuId) ?? 0) + score);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Voisinages MU des titres de la bibliothèque, mis en cache sur disque. */
async function fetchLiveGraph(
  muIds: string[],
  cachePath: string,
): Promise<GraphLinkRow[]> {
  const cache: Record<string, unknown> = fs.existsSync(cachePath)
    ? JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    : {};

  let fetched = 0;
  for (const muId of muIds) {
    if (cache[muId]) continue;
    try {
      const { data } = await axios.get(MU_DETAIL_URL.concat(muId));
      cache[muId] = data;
      fetched += 1;
    } catch (err) {
      process.stdout.write(
        `  ! fiche ${muId} indisponible (${(err as Error).message})\n`,
      );
      cache[muId] = {};
    }
    await sleep(MU_DELAY_MS);
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf-8');
  process.stdout.write(
    `  ${fetched} fiche(s) téléchargée(s), ${
      muIds.length - fetched
    } depuis le cache (${cachePath})\n`,
  );

  const rows: GraphLinkRow[] = [];
  for (const muId of muIds) {
    const neighbourhood = mapSeriesNeighbourhood(Number(muId), cache[muId]);
    for (const link of neighbourhood.category) {
      rows.push({
        source_mu_id: muId,
        recommended_mu_id: String(link.seriesId),
        kind: 'category',
        relation_type: null,
        weight: link.weight,
      });
    }
    for (const link of neighbourhood.related) {
      rows.push({
        source_mu_id: muId,
        recommended_mu_id: String(link.seriesId),
        kind: 'related',
        relation_type: link.relationType,
        weight: 0,
      });
    }
  }
  return rows;
}

/** Répartition par type d'une liste de mu_id. */
function typeBreakdown(
  muIds: string[],
  typeByMuId: Map<string, string | null>,
): string {
  const counts = new Map<string, number>();
  for (const muId of muIds) {
    const type = typeByMuId.get(muId) ?? '(inconnu)';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(
      ([type, count]) =>
        `${type} ${count} (${(
          (count / Math.max(muIds.length, 1)) *
          100
        ).toFixed(1)} %)`,
    )
    .join(' · ');
}

/**
 * Retire des métadonnées TypeORM les colonnes que la base ne possède pas
 * encore, et indique si `manga_recommendation.kind` existe.
 *
 * Permet de faire tourner le code de la branche contre le schéma de
 * production ACTUEL (lecture seule, migration non déployée).
 */
async function alignMetadataWithDatabase(
  dataSource: DataSource,
): Promise<boolean> {
  const rows: { table_name: string; column_name: string }[] =
    await dataSource.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema()`,
    );
  const present = new Set(
    rows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  for (const metadata of dataSource.entityMetadatas) {
    const keep = (column: { databaseName: string }) =>
      present.has(`${metadata.tableName}.${column.databaseName}`);
    metadata.columns = metadata.columns.filter(keep);
    metadata.ownColumns = metadata.ownColumns.filter(keep);
  }
  return present.has('manga_recommendation.kind');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST ?? '127.0.0.1',
    port: Number(process.env.DATABASE_PORT ?? 15432),
    database: process.env.DATABASE_NAME ?? 'MangaTracker',
    username: process.env.DATABASE_USER ?? 'postgres',
    password: process.env.DATABASE_PASSWORD,
    entities: [path.join(__dirname, '..', 'src', '**', '*.entity.ts')],
    synchronize: false,
    logging: ['error'],
  });
  await dataSource.initialize();

  try {
    // La prod peut être ANTÉRIEURE à la migration `1788480000000` : on veut
    // pouvoir mesurer avant de déployer. On aligne donc les métadonnées
    // TypeORM sur les colonnes réellement présentes, sinon le moindre
    // `getMany()` demanderait `reco_graph_attempted_at` et échouerait.
    const hasKind = await alignMetadataWithDatabase(dataSource);
    if (!hasKind) {
      process.stdout.write(
        '\n(!) `manga_recommendation.kind` absent : schéma antérieur à la ' +
          'migration 1788480000000 — tous les liens existants sont traités ' +
          'comme `manual`, ce qui est exactement ce que la migration en fera.\n',
      );
    }
    const userMangaRepository = dataSource.getRepository(UserManga);
    const mangaRepository = dataSource.getRepository(Manga);
    const recoRepository = dataSource.getRepository(MangaRecommendation);

    const userMangas = await userMangaRepository.find({
      where: { user: { id: options.userId } },
      relations: ['manga'],
    });
    if (userMangas.length === 0) {
      throw new Error(`Bibliothèque vide pour l'utilisateur ${options.userId}`);
    }
    const libraryMuIds = userMangas.map((um) => um.manga.mu_id);
    const excluded = new Set(libraryMuIds);
    const profile = computeTypeProfile(userMangas);

    process.stdout.write(
      `\n=== Bibliothèque utilisateur ${options.userId} — ${userMangas.length} titre(s)\n`,
    );
    process.stdout.write(
      `Profil de type : ${[...profile.shares.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, share]) => `${type} ${(share * 100).toFixed(1)} %`)
        .join(' · ')}\n`,
    );

    // ---------------------------------------------------------------- AVANT
    const manualLinks = await recoRepository
      .createQueryBuilder('mr')
      .select('mr.source_mu_id::text', 'source_mu_id')
      .addSelect('mr.recommended_mu_id::text', 'recommended_mu_id')
      .addSelect('mr.weight', 'weight')
      .where('mr.source_mu_id IN (:...ids)', { ids: libraryMuIds })
      .andWhere(hasKind ? 'mr.kind = :kind' : '1 = 1', { kind: 'manual' })
      .getRawMany<{
        source_mu_id: string;
        recommended_mu_id: string;
        weight: string;
      }>();

    const before = new Map<string, ScoredEntry>();
    for (const um of userMangas) {
      const multiplier = multiplierOf(um);
      const links = manualLinks
        .filter((row) => row.source_mu_id === um.manga.mu_id)
        .sort((a, b) => Number(b.weight) - Number(a.weight))
        .slice(0, MAX_RECOS_PER_SOURCE);
      for (const row of links) {
        if (excluded.has(row.recommended_mu_id)) continue;
        addContribution(
          before,
          row.recommended_mu_id,
          um.manga.mu_id,
          Number(row.weight) * multiplier,
        );
      }
    }
    const manualPoolSize = before.size;
    // Origine de chaque candidat — c'est elle qui dit d'où vient réellement
    // ce que l'utilisateur voit : un vrai voisinage MU, ou une heuristique
    // « même genre, bien noté » du catalogue local.
    const origin = new Map<string, string>();
    for (const muId of before.keys()) origin.set(muId, 'liens manuels MU');

    // Complément catalogue (VRAI service) — comme en production.
    const catalogService = new CatalogCandidateService(mangaRepository);
    let catalogAdded = 0;
    if (before.size < CATALOG_MIN_POOL) {
      for (const candidate of await catalogService.findCandidates(
        userMangas,
        excluded,
      )) {
        if (before.has(candidate.mu_id)) continue;
        before.set(candidate.mu_id, {
          score: candidate.score,
          sources: new Map(
            candidate.sourceMuIds.map((id) => [id, candidate.score]),
          ),
        });
        origin.set(candidate.mu_id, 'catalogue local (genres + note)');
        catalogAdded += 1;
      }
    }

    // ---------------------------------------------------------------- APRÈS
    process.stdout.write(
      `\n=== Graphe (${
        options.live ? 'lecture MangaUpdates à chaud' : 'manga_recommendation'
      })\n`,
    );
    if (!options.live && !hasKind) {
      throw new Error(
        'Le mode --db exige la migration 1788480000000 (colonne `kind`). ' +
          'Avant déploiement, utiliser le mode --live.',
      );
    }
    const graphRows = options.live
      ? await fetchLiveGraph(libraryMuIds, options.cachePath)
      : (
          await recoRepository
            .createQueryBuilder('mr')
            .select('mr.source_mu_id::text', 'source_mu_id')
            .addSelect('mr.recommended_mu_id::text', 'recommended_mu_id')
            .addSelect('mr.kind', 'kind')
            .addSelect('mr.relation_type', 'relation_type')
            .addSelect('mr.weight', 'weight')
            .where('mr.source_mu_id IN (:...ids)', { ids: libraryMuIds })
            .andWhere('mr.kind IN (:...kinds)', {
              kinds: ['category', 'related'],
            })
            .getRawMany<GraphLinkRow>()
        ).map((row) => ({ ...row, weight: Number(row.weight) }));

    const contexts = buildGraphSourceContexts(userMangas);
    const contributions = scoreGraphLinks(graphRows, contexts, excluded);
    const after = new Map<string, ScoredEntry>(
      [...before].map(([muId, entry]) => [
        muId,
        { score: entry.score, sources: new Map(entry.sources) },
      ]),
    );
    for (const contribution of contributions) {
      addContribution(
        after,
        contribution.muId,
        contribution.sourceMuId,
        contribution.score,
      );
      if (!origin.has(contribution.muId)) {
        origin.set(contribution.muId, `graphe MU (${contribution.kind})`);
      }
    }

    // ------------------------------------------------------------- RAPPORT
    const allMuIds = [...new Set([...before.keys(), ...after.keys()])];
    const typeByMuId = new Map<string, string | null>();
    for (const chunkStart of [...Array(Math.ceil(allMuIds.length / 1000))].map(
      (_, i) => i * 1000,
    )) {
      const chunk = allMuIds.slice(chunkStart, chunkStart + 1000);
      const rows = await mangaRepository
        .createQueryBuilder('m')
        .select('m.mu_id::text', 'mu_id')
        .addSelect('m.type', 'type')
        .where('m.mu_id IN (:...ids)', { ids: chunk })
        .getRawMany<{ mu_id: string; type: string | null }>();
      for (const row of rows) typeByMuId.set(row.mu_id, row.type);
    }

    const rank = (pool: Map<string, ScoredEntry>): string[] =>
      interleaveByTypeMix(
        [...pool.entries()]
          .map(([muId, entry]) => ({ muId, score: entry.score }))
          .sort((a, b) => b.score - a.score),
        (item) => typeByMuId.get(item.muId),
        profile,
      )
        .slice(0, options.top)
        .map((item) => item.muId);

    process.stdout.write(
      `  ${graphRows.length} lien(s) de graphe, ${contributions.length} contribution(s) retenue(s)\n`,
    );
    process.stdout.write('\n=== POOL DE CANDIDATS\n');
    process.stdout.write(
      `AVANT  ${before.size} titres (dont ${manualPoolSize} par liens manuels, ${catalogAdded} par le catalogue)\n`,
    );
    process.stdout.write(
      `       ${typeBreakdown([...before.keys()], typeByMuId)}\n`,
    );
    process.stdout.write(`APRÈS  ${after.size} titres\n`);
    process.stdout.write(
      `       ${typeBreakdown([...after.keys()], typeByMuId)}\n`,
    );

    process.stdout.write(
      `\n=== TOP ${options.top} SERVI (après prorata de type)\n`,
    );
    const beforeTop = rank(before);
    const afterTop = rank(after);
    process.stdout.write(`AVANT  ${typeBreakdown(beforeTop, typeByMuId)}\n`);
    process.stdout.write(`APRÈS  ${typeBreakdown(afterTop, typeByMuId)}\n`);
    const renewed = afterTop.filter((muId) => !beforeTop.includes(muId)).length;
    process.stdout.write(
      `Renouvellement du top : ${renewed}/${afterTop.length} titres inédits\n`,
    );

    // L'origine des cartes servies est le vrai enjeu : avant, l'essentiel du
    // pool venait d'une heuristique « même genre, bien noté » du catalogue
    // local, faute de voisinage MU exploitable.
    const originBreakdown = (muIds: string[]): string => {
      const counts = new Map<string, number>();
      for (const muId of muIds) {
        const key = origin.get(muId) ?? 'inconnue';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => `${key} ${count}`)
        .join(' · ');
    };
    process.stdout.write('\n=== ORIGINE DES CANDIDATS SERVIS\n');
    process.stdout.write(`AVANT  ${originBreakdown(beforeTop)}\n`);
    process.stdout.write(`APRÈS  ${originBreakdown(afterTop)}\n`);

    const graphTargets = new Set(contributions.map((c) => c.muId));
    const unknownTargets = [...graphTargets].filter(
      (muId) => !typeByMuId.has(muId),
    );
    process.stdout.write(
      `Cibles du graphe absentes du catalogue local : ` +
        `${unknownTargets.length}/${graphTargets.size} ` +
        '(créées en stub par RecoGraphIngestService en production)\n',
    );

    const titles = await mangaRepository
      .createQueryBuilder('m')
      .select('m.mu_id::text', 'mu_id')
      .addSelect('m.title', 'title')
      .where('m.mu_id IN (:...ids)', { ids: afterTop.slice(0, 10) })
      .getRawMany<{ mu_id: string; title: string }>();
    const titleByMuId = new Map(titles.map((row) => [row.mu_id, row.title]));
    process.stdout.write('\n=== 10 premières cartes APRÈS\n');
    afterTop.slice(0, 10).forEach((muId, index) => {
      process.stdout.write(
        `  ${String(index + 1).padStart(2)}. [${typeByMuId.get(muId) ?? '?'}] ${
          titleByMuId.get(muId) ?? muId
        }\n`,
      );
    });
    process.stdout.write(
      '\nSuggestions dérivées des données de MangaUpdates (https://www.mangaupdates.com).\n',
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
