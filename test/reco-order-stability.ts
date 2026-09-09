/**
 * Vérifie sur la base de PRODUCTION que l'ordre des recommandations est
 * déterministe et que deux tailles de page partagent leur préfixe.
 *
 *   npm run verify:reco-order -- --user=1
 *
 * ## Ce qui est vérifié
 *
 * 1. **Reproductibilité** : le pool est reconstruit DEUX fois, de bout en
 *    bout, avec les vraies requêtes. Les deux listes canoniques doivent être
 *    identiques, position par position. C'est le test que le code applicatif
 *    ne peut pas faire : les dépôts mockés sont déterministes par
 *    construction, la non-reproductibilité venait de la base (`getRawMany()`
 *    sans `ORDER BY`, `LIMIT` sur des valeurs ex æquo).
 * 2. **Préfixe partagé** : la page de l'accueil (`limit=10`) doit être
 *    exactement le début de la page « Voir tout » (`limit=50`) — le symptôme
 *    rapporté le 2026-09-09.
 * 3. **Ex æquo aux frontières de troncature** : combien de coupes tombent sur
 *    une égalité de poids/note. C'est la mesure de ce que le départage
 *    secondaire par `mu_id` sécurise réellement pour cet utilisateur.
 * 4. **Coût mémoire** de la liste canonique mise en cache.
 *
 * ## Base de production en LECTURE SEULE
 *
 * Le script n'ouvre que des SELECT (`synchronize: false`, aucune migration,
 * aucun `save`, aucun appel réseau vers MangaUpdates). Rien n'est écrit.
 *
 * Connexion via le tunnel : `DATABASE_HOST` (défaut 127.0.0.1),
 * `DATABASE_PORT` (défaut 15432), `DATABASE_NAME`, `DATABASE_USER`,
 * `DATABASE_PASSWORD`.
 *
 * Options : `--user=<id>` (défaut 1), `--home=<n>` (défaut 10),
 * `--all=<n>` (défaut 50).
 */
import 'reflect-metadata';
import * as path from 'path';
import { DataSource, Repository } from 'typeorm';
import { Manga } from '../src/api/mangas/manga.entity';
import { MangaRecommendation } from '../src/api/mangas/manga-recommendation.entity';
import { UserManga } from '../src/api/mangas/user-manga.entity';
import { CatalogCandidateService } from '../src/api/recommendations/catalog-candidate.service';
import { RecoGraphCandidateService } from '../src/api/recommendations/reco-graph-candidate.service';
import { computeAffinityMultiplier } from '../src/api/recommendations/library-affinity';
import {
  byValueDescThenId,
  compareIdAsc,
} from '../src/api/recommendations/reco-ordering';
import {
  clampRecoWindow,
  paginate,
  recoCanonicalMaxItems,
} from '../src/api/recommendations/reco-pagination';
import { ScoredEntry } from '../src/api/recommendations/scored-entry.interface';
import {
  computeTypeProfile,
  interleaveByTypeMix,
} from '../src/api/recommendations/type-profile';

/** Miroir de `RecommendationService.MAX_RECOS_PER_SOURCE`. */
const MAX_RECOS_PER_SOURCE = 40;
/** Miroir de `RecommendationService.CATALOG_MIN_POOL`. */
const CATALOG_MIN_POOL = 150;

interface Options {
  userId: number;
  home: number;
  all: number;
}

function parseOptions(argv: string[]): Options {
  const value = (name: string, fallback: number): number => {
    const found = argv.find((arg) => arg.startsWith(`--${name}=`));
    const parsed = found ? Number(found.split('=')[1]) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    userId: value('user', 1),
    home: value('home', 10),
    all: value('all', 50),
  };
}

/** Bibliothèque ordonnée — miroir de `RecommendationService.loadLibrary`. */
async function loadLibrary(
  userMangas: Repository<UserManga>,
  userId: number,
): Promise<UserManga[]> {
  const rows = await userMangas.find({
    where: { user: { id: userId } },
    relations: ['manga'],
  });
  return rows.sort((a, b) =>
    compareIdAsc(a.manga?.mu_id ?? '', b.manga?.mu_id ?? ''),
  );
}

/** Bibliothèque ∪ titres écartés — miroir de `DismissalService`. */
async function loadExclusions(
  dataSource: DataSource,
  userId: number,
  library: UserManga[],
): Promise<Set<string>> {
  const excluded = new Set(library.map((um) => um.manga.mu_id));
  const rows: { mu_id: string }[] = await dataSource.query(
    `SELECT manga_id::text AS mu_id FROM user_manga_dismissal WHERE user_id = $1`,
    [userId],
  );
  for (const row of rows) excluded.add(row.mu_id);
  return excluded;
}

/**
 * Pool `manual` — miroir de `MangasService.getCachedRecommendations` +
 * `RecommendationService.scoreRecos`, ordre total compris.
 *
 * @returns le nombre de troncatures tombant sur une égalité de poids.
 */
async function scoreManualLinks(
  recos: Repository<MangaRecommendation>,
  library: UserManga[],
  excluded: Set<string>,
  scoreMap: Map<string, ScoredEntry>,
): Promise<number> {
  let tiedCuts = 0;
  for (const um of library) {
    const rows = await recos
      .createQueryBuilder('mr')
      .where('mr.source_mu_id = :sourceMuId', { sourceMuId: um.manga.mu_id })
      .andWhere('mr.kind IN (:...kinds)', { kinds: ['manual'] })
      .orderBy('mr.weight', 'DESC')
      .addOrderBy('mr.recommended_mu_id', 'ASC')
      .getMany();
    if (rows.length > MAX_RECOS_PER_SOURCE) {
      const last = Number(rows[MAX_RECOS_PER_SOURCE - 1].weight);
      const next = Number(rows[MAX_RECOS_PER_SOURCE].weight);
      if (last === next) tiedCuts += 1;
    }

    const multiplier = computeAffinityMultiplier(um);
    for (const reco of rows.slice(0, MAX_RECOS_PER_SOURCE)) {
      if (excluded.has(reco.recommended_mu_id)) continue;
      const contribution = Number(reco.weight) * multiplier;
      let entry = scoreMap.get(reco.recommended_mu_id);
      if (!entry) {
        entry = { score: 0, sources: new Map() };
        scoreMap.set(reco.recommended_mu_id, entry);
      }
      entry.score += contribution;
      entry.sources.set(
        um.manga.mu_id,
        (entry.sources.get(um.manga.mu_id) ?? 0) + contribution,
      );
    }
  }
  return tiedCuts;
}

/**
 * Construit la liste canonique d'un utilisateur — même enchaînement que
 * `RecommendationService.buildCanonicalList`, avec les VRAIS services de
 * candidats (graphe MU, catalogue local) et le vrai entrelacement.
 */
async function buildCanonicalMuIds(
  dataSource: DataSource,
  userId: number,
): Promise<{
  muIds: string[];
  poolSize: number;
  tiedManualCuts: number;
  tiedScores: number;
}> {
  const userMangas = dataSource.getRepository(UserManga);
  const recos = dataSource.getRepository(MangaRecommendation);
  const mangas = dataSource.getRepository(Manga);

  const library = await loadLibrary(userMangas, userId);
  const excluded = await loadExclusions(dataSource, userId, library);
  const scoreMap = new Map<string, ScoredEntry>();

  const tiedManualCuts = await scoreManualLinks(
    recos,
    library,
    excluded,
    scoreMap,
  );

  const graph = new RecoGraphCandidateService(recos);
  await graph.augment(library, excluded, scoreMap);

  if (scoreMap.size < CATALOG_MIN_POOL) {
    const catalog = new CatalogCandidateService(mangas);
    for (const candidate of await catalog.findCandidates(library, excluded)) {
      if (scoreMap.has(candidate.mu_id)) continue;
      if (excluded.has(candidate.mu_id)) continue;
      const sources = new Map<string, number>();
      for (const source of candidate.sourceMuIds) {
        sources.set(source, candidate.score);
      }
      scoreMap.set(candidate.mu_id, { score: candidate.score, sources });
    }
  }

  const ranked = Array.from(scoreMap.entries())
    .map(([mu_id, entry]) => ({ mu_id, score: entry.score }))
    .sort(
      byValueDescThenId<{ mu_id: string; score: number }>(
        (entry) => entry.score,
        (entry) => entry.mu_id,
      ),
    );

  const typeByMuId = new Map<string, string | null>();
  if (ranked.length > 0) {
    const rows = await mangas
      .createQueryBuilder('m')
      .select('m.mu_id', 'mu_id')
      .addSelect('m.type', 'type')
      .where('m.mu_id IN (:...ids)', { ids: ranked.map((r) => r.mu_id) })
      .getRawMany<{ mu_id: string; type: string | null }>();
    for (const row of rows) typeByMuId.set(row.mu_id, row.type);
  }

  const ordered = interleaveByTypeMix(
    ranked,
    (entry) => typeByMuId.get(entry.mu_id),
    computeTypeProfile(library),
  );

  // Combien de positions du classement ne sont départagées QUE par le
  // `mu_id` : c'est exactement ce que le correctif sécurise.
  let tiedScores = 0;
  for (let i = 1; i < ranked.length; i++) {
    if (ranked[i].score === ranked[i - 1].score) tiedScores += 1;
  }

  return {
    muIds: ordered.slice(0, recoCanonicalMaxItems()).map((e) => e.mu_id),
    poolSize: scoreMap.size,
    tiedManualCuts,
    tiedScores,
  };
}

/** Première position où deux listes divergent, ou -1. */
function firstDivergence(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : length;
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

  let failures = 0;
  try {
    process.stdout.write(
      `\nStabilité de l'ordre des recommandations — user ${options.userId}\n` +
        `Liste canonique plafonnée à ${recoCanonicalMaxItems()} entrées.\n\n`,
    );

    const first = await buildCanonicalMuIds(dataSource, options.userId);
    const second = await buildCanonicalMuIds(dataSource, options.userId);

    process.stdout.write(
      `Pool scoré        : ${first.poolSize} candidat(s)\n` +
        `Liste canonique   : ${first.muIds.length} carte(s)\n` +
        `Scores ex æquo    : ${first.tiedScores} position(s) départagée(s) par le seul mu_id\n` +
        `Coupes ex æquo    : ${first.tiedManualCuts} source(s) tronquée(s) sur une égalité de poids\n`,
    );

    // 1. Reproductibilité de bout en bout.
    const divergence = firstDivergence(first.muIds, second.muIds);
    if (divergence === -1) {
      process.stdout.write(
        `\n[OK]     Deux constructions successives rendent le MÊME ordre.\n`,
      );
    } else {
      failures += 1;
      process.stdout.write(
        `\n[ÉCHEC]  Les deux constructions divergent en position ${divergence} ` +
          `(${first.muIds[divergence]} vs ${second.muIds[divergence]}).\n`,
      );
    }

    // 2. Préfixe partagé entre les deux tailles de page réelles du client.
    const home = paginate(first.muIds, clampRecoWindow(options.home, 0));
    const all = paginate(first.muIds, clampRecoWindow(options.all, 0));
    const prefixDivergence = firstDivergence(home, all.slice(0, home.length));
    if (prefixDivergence === -1) {
      process.stdout.write(
        `[OK]     limit=${options.home} est le préfixe exact de limit=${options.all} ` +
          `(${home.length} carte(s) comparées).\n`,
      );
    } else {
      failures += 1;
      process.stdout.write(
        `[ÉCHEC]  Préfixe divergent en position ${prefixDivergence}.\n`,
      );
    }

    // 3. Recollement des pages successives.
    const pageSize = clampRecoWindow(options.all, 0).limit;
    const glued = [
      ...paginate(first.muIds, clampRecoWindow(pageSize, 0)),
      ...paginate(first.muIds, clampRecoWindow(pageSize, pageSize)),
    ];
    const expected = first.muIds.slice(0, glued.length);
    if (firstDivergence(glued, expected) === -1) {
      process.stdout.write(
        `[OK]     Pages 1 et 2 (${pageSize} par page) se recollent sans trou ni doublon.\n`,
      );
    } else {
      failures += 1;
      process.stdout.write(`[ÉCHEC]  Recollement des pages incorrect.\n`);
    }

    // 4. Coût mémoire du cache canonique (mesure, pas une assertion).
    const bytesPerCard = 460;
    process.stdout.write(
      `\nCache canonique   : ~${(
        (first.muIds.length * bytesPerCard) /
        1024
      ).toFixed(0)} Kio pour cet utilisateur ` +
        `(~${((recoCanonicalMaxItems() * bytesPerCard) / 1024).toFixed(
          0,
        )} Kio au plafond).\n\n`,
    );
  } finally {
    await dataSource.destroy();
  }

  if (failures > 0) process.exitCode = 1;
}

void main();
