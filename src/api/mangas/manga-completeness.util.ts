import { Logger } from '@nestjs/common';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { MuRateLimitException } from './exceptions/mu-rate-limit.exception';
import { Manga } from './manga.entity';

/**
 * Complétude des données `manga` — helpers partagés (fix 2026-08-28).
 *
 * Symptôme d'origine : sur les cartes de recommandations, l'année et la note
 * en étoiles n'apparaissaient pas pour une partie des titres. Les DTO exposent
 * `0` quand `manga.year` / `manga.rating` sont NULL en base (repli assumé,
 * contrat DTO inchangé) et l'app traduit ce `0` en « donnée absente ». Le
 * problème est donc entièrement côté remplissage de la table `manga`.
 *
 * Ce module regroupe les deux briques transverses de la correction :
 *  1. la **doctrine null-safe** sur les colonnes nullable (une valeur déjà
 *     hydratée n'est jamais remplacée par un null venu de MU) ;
 *  2. l'**hydratation à la demande** fire-and-forget déclenchée sur le chemin
 *     des recommandations.
 */

/**
 * Colonnes nullable protégées : elles ne sont écrasées QUE si la source MU
 * fournit une valeur exploitable. Un payload MU sans `bayesian_rating`
 * (titre peu voté) ou sans année ne doit pas remettre à NULL une valeur déjà
 * hydratée — le manga perdrait son année / ses étoiles sur les cartes et
 * sortirait des sélections `rating >= 7` (`CatalogCandidateService`,
 * `findSleeperHits`).
 *
 * Source de vérité unique : `catalog-sync.mapper.ts` (upsert catalogue),
 * `MangasService.getMangaDetails` et `MangaSyncService` s'y alignent tous.
 */
export const PROTECTED_NULLABLE_COLUMNS = [
  'year',
  'rating',
  'small_cover_url',
  'medium_cover_url',
  'genres',
] as const;

export type ProtectedNullableColumn =
  (typeof PROTECTED_NULLABLE_COLUMNS)[number];

/**
 * Sous-ensemble de `MangaDetailsDto` consommé ici. Typage structurel
 * volontaire : évite d'ajouter une importation au cycle existant
 * `manga.entity` ↔ `dto/manga-details.dto`.
 */
export interface MangaDetailValues {
  year?: number | string | null;
  rating?: number | null;
  smallCoverUrl?: string | null;
  mediumCoverUrl?: string | null;
}

/**
 * Construit la fraction « colonnes protégées » d'un UPDATE `manga` à partir
 * d'un détail MU.
 *
 * Règle : une valeur **absente** (`null`, `undefined`, chaîne vide) est
 * omise de l'objet → la colonne n'apparaît pas dans le `SET` → la valeur en
 * base est conservée. Une valeur **réelle** est présente dans l'objet et
 * écrase normalement l'ancienne : on refuse le null, on ne fige pas la
 * donnée.
 *
 * `genres` suit la même règle, avec une nuance héritée de `normalizeGenres` :
 * `[]` (MU a répondu « aucun genre ») est une valeur réelle et s'écrit, seul
 * `null` (forme MU inexploitable) est ignoré.
 *
 * @param details Détail MU mappé (camelCase).
 * @param normalizedGenres Genres déjà passés par `normalizeGenres`, ou
 *   `undefined` si l'appelant ne touche pas à cette colonne.
 * @returns Objet partiel prêt à être étalé dans un `.set()` / `.update()`.
 */
export function buildProtectedColumnsUpdate(
  details: MangaDetailValues,
  normalizedGenres?: string[] | null,
): QueryDeepPartialEntity<Manga> {
  const candidates: Record<ProtectedNullableColumn, unknown> = {
    year: details.year,
    rating: details.rating,
    small_cover_url: details.smallCoverUrl,
    medium_cover_url: details.mediumCoverUrl,
    genres: normalizedGenres,
  };

  const update: Record<string, unknown> = {};
  for (const column of PROTECTED_NULLABLE_COLUMNS) {
    const value = candidates[column];
    if (value === null || value === undefined || value === '') continue;
    update[column] = value;
  }
  return update as QueryDeepPartialEntity<Manga>;
}

/**
 * Fraction « titres alternatifs » d'un UPDATE `manga`, en null-safe.
 *
 * `associated` n'est renseigné que par `/v1/series/{id}` — jamais par
 * `/series/search`. Le mapping DTO (`MangaDetailsDto.fromMU`) applique
 * `muObject['associated'] ?? []`, si bien qu'une réponse MU sans titres
 * alternatifs produit un tableau VIDE, indiscernable d'un « MU n'a rien
 * renvoyé ». L'UPDATE de `getMangaDetails` écrivait ce `[]` sans condition :
 * une fiche déjà pourvue de ses titres alternatifs pouvait donc les PERDRE
 * au passage suivant (réponse MU partielle, champ absent).
 *
 * Règle, alignée sur `buildProtectedColumnsUpdate` : la colonne n'entre dans
 * le `SET` que si MU fournit au moins un titre. Sinon elle est omise et la
 * valeur en base est conservée.
 *
 * Conséquence assumée : une série qui n'a réellement AUCUN titre alternatif
 * garde `associated = NULL` et reste éligible au job d'hydratation. C'est la
 * garde `hydration_attempted_at` (30 j) qui l'empêche de brûler le budget en
 * boucle — exactement le traitement déjà réservé à un titre sans note ni
 * année.
 */
export function buildAssociatedUpdate(
  associated: { title: string }[] | null | undefined,
): QueryDeepPartialEntity<Manga> {
  if (!Array.isArray(associated) || associated.length === 0) return {};
  return { associated } as QueryDeepPartialEntity<Manga>;
}

/**
 * Plafond DUR d'hydratations déclenchées par UNE requête de recommandations.
 * Aligné sur la politique réseau MU (~60 req/min anonyme) : au pire 8 appels
 * détail en tâche de fond par requête, jamais dans le chemin de réponse.
 */
export const ON_DEMAND_HYDRATION_CAP = 8;

/** Forme minimale d'un DTO carte suffisante pour juger de sa complétude. */
export interface HydratableDto {
  muId: number;
  year: number;
  rating: number;
}

/**
 * Un DTO est « incomplet » quand l'app n'a rien à afficher sur la ligne meta
 * de la carte : `year == 0` ou `rating == 0` (le repli `0` du DTO signifie
 * « colonne NULL en base »).
 */
export function isIncompleteDto(dto: HydratableDto): boolean {
  return dto.year === 0 || dto.rating === 0;
}

/**
 * Déclenche l'hydratation MU des DTO incomplets, en **fire-and-forget**.
 *
 * Calqué sur le background refresh des covers de
 * `MangasService.getRecommendationsAsQuickView` : on n'attend jamais MU, la
 * requête principale répond avec les données actuelles (les cartes concernées
 * restent sans année/étoile pour CE rendu) et la base est complétée en tâche
 * de fond pour les rendus suivants.
 *
 * Garanties :
 *  - au plus `ON_DEMAND_HYDRATION_CAP` (8) mangas par appel, dédupliqués ;
 *  - aucune exception ne remonte : un échec MU (y compris un 429
 *    `MuRateLimitException`) est loggé puis avalé, la requête principale ne
 *    peut pas échouer à cause de l'hydratation.
 *
 * ⚠️ Visibilité : les réponses de recommandations sont mises en cache par
 * `RecoCacheService` (TTL 1 h). L'amélioration n'est donc perceptible qu'au
 * **prochain miss de cache** de l'utilisateur, pas sur la requête en cours.
 *
 * @returns Les `mu_id` effectivement programmés (utile aux tests/logs).
 */
export function hydrateIncompleteDtosInBackground(
  dtos: HydratableDto[],
  hydrate: (muId: number) => Promise<unknown>,
  logger: Logger,
): number[] {
  const targets: number[] = [];
  const seen = new Set<number>();

  for (const dto of dtos) {
    if (targets.length >= ON_DEMAND_HYDRATION_CAP) break;
    if (!isIncompleteDto(dto)) continue;
    const muId = Number(dto.muId);
    if (!Number.isFinite(muId) || muId <= 0 || seen.has(muId)) continue;
    seen.add(muId);
    targets.push(muId);
  }

  if (targets.length === 0) return targets;

  logger.log(
    `Hydratation à la demande de ${
      targets.length
    } manga(s) incomplet(s) : ${targets.join(', ')}`,
  );

  // Pas de `await` : fire-and-forget strict. `Promise.resolve().then` protège
  // aussi d'un `hydrate` qui lèverait de façon synchrone.
  Promise.allSettled(
    targets.map((muId) =>
      Promise.resolve()
        .then(() => hydrate(muId))
        .catch((err: unknown) => {
          if (err instanceof MuRateLimitException) {
            // 429 MU : rien d'anormal, le job nightly reprendra la ligne.
            logger.warn(`Hydratation ${muId} reportée : rate limit MU (429)`);
            return;
          }
          logger.warn(
            `Hydratation ${muId} en échec : ${(err as Error)?.message ?? err}`,
          );
        }),
    ),
  ).catch(() => undefined);

  return targets;
}
