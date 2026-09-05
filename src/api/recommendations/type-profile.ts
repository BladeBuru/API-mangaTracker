import { SelectQueryBuilder } from 'typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { UserManga } from '@/api/mangas/user-manga.entity';

/**
 * Profil de type d'un utilisateur et sélection « au prorata » — fonctions
 * PURES (aucune I/O), partagées par tous les chemins de recommandation
 * (liste plate, sections par genre, sleepers, candidats catalogue).
 *
 * ## Le bug (prod, 2026-09-05)
 *
 * Répartition réelle des bibliothèques (77 titres, ids masqués) : 73 %
 * Manhwa, 13 % Manhua, 10 % Manga. Faute de colonne `type`, le catalogue
 * (≈ 80 000 titres, très majoritairement `Manga`) et le tri par note
 * servaient exclusivement des mangas à des lecteurs de manhwa.
 *
 * ## Le principe
 *
 * 1. `computeTypeProfile` : part pondérée de chaque type dans la
 *    bibliothèque (statut de lecture × note perso, SANS décroissance
 *    temporelle : le goût pour un format est un trait stable, la récence
 *    ferait dériver le profil vers les derniers ajouts).
 * 2. `interleaveByTypeMix` : réordonne une liste déjà triée par score de
 *    façon que TOUT préfixe respecte ≈ les parts du profil (round-robin à
 *    déficit — un lecteur à 80 % manhwa voit ≈ 80 % de manhwa dès les
 *    premières cartes, jamais zéro tant qu'il reste un candidat). À
 *    l'intérieur d'un type, l'ordre par score est conservé.
 * 3. `planTypeQueryBuckets` : répartit un budget de requête catalogue par
 *    type, pour que les candidats manhwa EXISTENT dans le pool (un
 *    `ORDER BY rating LIMIT 300` global ne remonterait que des mangas).
 *
 * Type NULL = inconnu (ligne pas encore revisitée par le catalogue) :
 * autorisé, mais pénalisé de moitié quand la préférence est marquée.
 */

/** Clé de bucket des titres dont le type est inconnu. */
export const UNKNOWN_TYPE_KEY = '__unknown__';

/** Part dominante à partir de laquelle la préférence est « marquée ». */
export const MARKED_PREFERENCE_SHARE = 0.6;

/**
 * Sous ce taux (pondéré) de titres typés dans la bibliothèque, le profil
 * est jugé non fiable et ignoré (comportement historique). Le rattrapage
 * des bibliothèques au démarrage rend ce cas transitoire.
 */
export const MIN_KNOWN_COVERAGE = 0.5;

/** Facteur appliqué à la part des inconnus quand la préférence est marquée. */
export const UNKNOWN_PENALTY = 0.5;

/**
 * Part réservée aux types présents dans le pool mais absents du profil
 * (découverte : un lecteur 100 % manhwa voit ~1 titre sur 20 d'un autre
 * format). Mettre à 0 pour un respect strict du profil.
 */
export const DISCOVERY_SHARE = 0.05;

/** Miroir de `RecommendationService.STATUS_MULTIPLIER`. */
const STATUS_WEIGHT: Record<string, number> = {
  completed: 1.5,
  caughtUp: 1.3,
  reading: 1.2,
  readLater: 0.8,
};

export interface TypeProfile {
  /** Part (0..1) de chaque type connu, pondérée. Somme = 1. Vide = pas de profil. */
  shares: Map<string, number>;
  /** Type dominant et sa part, ou `null` sans profil. */
  dominant: { type: string; share: number } | null;
  /** Préférence marquée : part dominante ≥ `MARKED_PREFERENCE_SHARE`. */
  marked: boolean;
  /** Part pondérée de la bibliothèque dont le type est inconnu. */
  unknownShare: number;
  /** Nombre de titres typés ayant contribué. */
  knownCount: number;
}

export function emptyTypeProfile(unknownShare = 0): TypeProfile {
  return {
    shares: new Map(),
    dominant: null,
    marked: false,
    unknownShare,
    knownCount: 0,
  };
}

export function isEmptyTypeProfile(profile: TypeProfile): boolean {
  return profile.shares.size === 0;
}

/** Poids d'un titre de bibliothèque : statut × note perso (sans récence). */
export function libraryWeight(um: UserManga): number {
  const ratingWeight = um.user_rating > 0 ? um.user_rating / 5.0 : 1.0;
  const statusWeight = STATUS_WEIGHT[um.readingStatus] ?? 1.0;
  return ratingWeight * statusWeight;
}

/** Profil de type pondéré d'une bibliothèque (voir doc de module). */
export function computeTypeProfile(userMangas: UserManga[]): TypeProfile {
  const weights = new Map<string, number>();
  let known = 0;
  let unknown = 0;
  let knownCount = 0;
  for (const um of userMangas) {
    const weight = libraryWeight(um);
    const type = um.manga?.type;
    if (type) {
      weights.set(type, (weights.get(type) ?? 0) + weight);
      known += weight;
      knownCount += 1;
    } else {
      unknown += weight;
    }
  }
  const total = known + unknown;
  const unknownShare = total > 0 ? unknown / total : 0;
  if (known === 0 || known / total < MIN_KNOWN_COVERAGE) {
    return emptyTypeProfile(unknownShare);
  }

  const shares = new Map<string, number>();
  let dominant: TypeProfile['dominant'] = null;
  for (const [type, weight] of weights) {
    const share = weight / known;
    shares.set(type, share);
    if (!dominant || share > dominant.share) dominant = { type, share };
  }
  return {
    shares,
    dominant,
    marked: dominant !== null && dominant.share >= MARKED_PREFERENCE_SHARE,
    unknownShare,
    knownCount,
  };
}

/**
 * Parts effectives des buckets d'une liste donnée : profil × (1 − inconnus)
 * × (1 − découverte), inconnus pénalisés si préférence marquée, découverte
 * répartie entre les types hors profil présents dans la liste.
 */
function effectiveShares(
  profile: TypeProfile,
  bucketKeys: Iterable<string>,
  unknownRatio: number,
): Map<string, number> {
  const keys = [...bucketKeys];
  const u = unknownRatio * (profile.marked ? UNKNOWN_PENALTY : 1);
  const others = keys.filter(
    (k) => k !== UNKNOWN_TYPE_KEY && !profile.shares.has(k),
  );
  const d = others.length > 0 ? DISCOVERY_SHARE : 0;

  // Le profil est renormalisé sur les types RÉELLEMENT présents dans la
  // liste : un type du profil sans candidat ne doit pas laisser une part
  // « en l'air » que le round-robin redistribuerait au hasard (elle irait
  // surtout aux inconnus, à l'encontre de la pénalité).
  const present = [...profile.shares].filter(([type]) => keys.includes(type));
  const presentSum = present.reduce((sum, [, share]) => sum + share, 0);

  const shares = new Map<string, number>();
  for (const [type, share] of present) {
    shares.set(type, (share / presentSum) * (1 - u) * (1 - d));
  }
  for (const type of others) shares.set(type, (d * (1 - u)) / others.length);
  shares.set(UNKNOWN_TYPE_KEY, u);

  // Normalisation finale (aucun type du profil présent → seuls inconnus et
  // découverte restent, leur somme est < 1).
  const total = [...shares.values()].reduce((sum, s) => sum + s, 0);
  if (total > 0 && Math.abs(total - 1) > 1e-9) {
    for (const [key, share] of shares) shares.set(key, share / total);
  }
  return shares;
}

/**
 * Réordonne `items` (déjà triés par score décroissant) pour que chaque
 * préfixe respecte ≈ les parts du profil. Round-robin à déficit : à chaque
 * position on émet le bucket dont le retard sur sa part cible est le plus
 * grand ; à égalité, le meilleur score. Un bucket épuisé laisse ses slots
 * aux autres au prorata. Sans profil, la liste est rendue telle quelle.
 */
export function interleaveByTypeMix<T>(
  items: T[],
  typeOf: (item: T) => string | null | undefined,
  profile: TypeProfile,
): T[] {
  if (items.length === 0 || isEmptyTypeProfile(profile)) return items;

  const buckets = new Map<string, Array<{ item: T; rank: number }>>();
  items.forEach((item, rank) => {
    const key = typeOf(item) || UNKNOWN_TYPE_KEY;
    const list = buckets.get(key);
    if (list) list.push({ item, rank });
    else buckets.set(key, [{ item, rank }]);
  });

  const unknownRatio =
    (buckets.get(UNKNOWN_TYPE_KEY)?.length ?? 0) / items.length;
  const shares = effectiveShares(profile, buckets.keys(), unknownRatio);

  const cursors = new Map<string, number>();
  const emitted = new Map<string, number>();
  const result: T[] = [];
  for (let position = 1; position <= items.length; position++) {
    let bestKey: string | null = null;
    let bestDeficit = -Infinity;
    let bestRank = Infinity;
    for (const [key, list] of buckets) {
      const cursor = cursors.get(key) ?? 0;
      if (cursor >= list.length) continue;
      const deficit =
        (shares.get(key) ?? 0) * position - (emitted.get(key) ?? 0);
      const rank = list[cursor].rank;
      const better =
        deficit > bestDeficit + 1e-9 ||
        (Math.abs(deficit - bestDeficit) <= 1e-9 && rank < bestRank);
      if (better) {
        bestKey = key;
        bestDeficit = deficit;
        bestRank = rank;
      }
    }
    if (bestKey === null) break;
    const list = buckets.get(bestKey) as Array<{ item: T; rank: number }>;
    const cursor = cursors.get(bestKey) ?? 0;
    result.push(list[cursor].item);
    cursors.set(bestKey, cursor + 1);
    emitted.set(bestKey, (emitted.get(bestKey) ?? 0) + 1);
  }
  return result;
}

/**
 * Bucket de requête catalogue : quel filtre `type` et combien de lignes.
 * - `all`     : pas de filtre (profil vide → requête historique unique) ;
 * - `known`   : `type = <T>` pour un type du profil ;
 * - `unknown` : `type IS NULL` (lignes pas encore typées) ;
 * - `other`   : types connus hors profil (découverte).
 */
export interface TypeQueryBucket {
  kind: 'all' | 'known' | 'unknown' | 'other';
  type?: string;
  limit: number;
}

/** Plancher de lignes par bucket typé (un type minoritaire reste présent). */
export const MIN_BUCKET_LIMIT = 10;

/** Répartit un budget de lignes catalogue par bucket de type. */
export function planTypeQueryBuckets(
  profile: TypeProfile,
  totalLimit: number,
): TypeQueryBucket[] {
  if (isEmptyTypeProfile(profile)) return [{ kind: 'all', limit: totalLimit }];
  const buckets: TypeQueryBucket[] = [];
  for (const [type, share] of profile.shares) {
    buckets.push({
      kind: 'known',
      type,
      limit: Math.max(MIN_BUCKET_LIMIT, Math.ceil(share * totalLimit)),
    });
  }
  // Inconnus : budget large tant que le catalogue n'est pas entièrement
  // typé (l'interleave les pénalise ensuite selon leur part réelle).
  buckets.push({
    kind: 'unknown',
    limit: Math.ceil(totalLimit * (profile.marked ? 0.35 : 0.5)),
  });
  buckets.push({
    kind: 'other',
    limit: Math.max(
      MIN_BUCKET_LIMIT,
      Math.ceil(totalLimit * DISCOVERY_SHARE * 2),
    ),
  });
  return buckets;
}

/**
 * Exécute une requête catalogue (alias `m`) par bucket de type — une seule
 * sans profil — triée par note décroissante et plafonnée au budget du
 * bucket, puis fusionne les résultats dédupliqués par `mu_id`. `createQuery`
 * est rappelé pour chaque bucket (un QueryBuilder TypeORM est mutable).
 */
export async function fetchByTypeBuckets(
  createQuery: () => SelectQueryBuilder<Manga>,
  profile: TypeProfile,
  totalLimit: number,
): Promise<Manga[]> {
  const seen = new Set<string>();
  const merged: Manga[] = [];
  for (const bucket of planTypeQueryBuckets(profile, totalLimit)) {
    const rows = await applyTypeBucket(createQuery(), bucket, profile)
      .orderBy('m.rating', 'DESC')
      .limit(bucket.limit)
      .getMany();
    for (const manga of rows) {
      if (seen.has(manga.mu_id)) continue;
      seen.add(manga.mu_id);
      merged.push(manga);
    }
  }
  return merged;
}

/** Applique le filtre d'un bucket à une requête `manga` (alias `m`). */
export function applyTypeBucket(
  qb: SelectQueryBuilder<Manga>,
  bucket: TypeQueryBucket,
  profile: TypeProfile,
): SelectQueryBuilder<Manga> {
  switch (bucket.kind) {
    case 'known':
      return qb.andWhere('m.type = :bucketType', { bucketType: bucket.type });
    case 'unknown':
      return qb.andWhere('m.type IS NULL');
    case 'other':
      return qb
        .andWhere('m.type IS NOT NULL')
        .andWhere('m.type NOT IN (:...profileTypes)', {
          profileTypes: [...profile.shares.keys()],
        });
    default:
      return qb;
  }
}
