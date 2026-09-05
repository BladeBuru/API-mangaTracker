import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { NSFW_GENRES } from '../constants';
import { Manga } from '../manga.entity';
import { HomeSectionDef } from './home-section.catalog';

/**
 * Requêtes des sections de l'accueil — lecture de la table `manga`
 * UNIQUEMENT (aucun appel MangaUpdates au moment de la requête).
 *
 * ## Règles communes (toutes sections)
 *
 * - cover présente (`medium_cover_url IS NOT NULL`) : une carte sans image
 *   n'a pas sa place sur un accueil visuel ;
 * - genres connus et **aucun genre NSFW** — même liste `NSFW_GENRES` et même
 *   prédicat `?|` que le catalogue (`exclude_genre` côté MU) et les
 *   recommandations (`CatalogCandidateService`). Les 143 lignes sans genres
 *   sont exclues par prudence (on ne peut pas prouver qu'elles ne sont pas
 *   NSFW).
 *
 * ## Règles par section (décisions, cf. CHANGELOG)
 *
 * - `latest` — « dernières sorties » : `year >= année courante − 1`, tri
 *   `year DESC, rating DESC NULLS LAST, total_chapters DESC, created_at DESC`.
 *   `year` est le SEUL signal de parution fiable : `created_at` reflète nos
 *   lots d'ingestion (56 000 lignes créées le même jour lors du rattrapage
 *   du catalogue), pas la publication ; `total_chapters` (alimenté par le
 *   job sorties) départage en faveur des titres qui paraissent réellement.
 * - `popular` — réutilise la logique de `/mangas/popular` (MU
 *   `orderby: rating`, NSFW exclus) appliquée au catalogue local :
 *   `rating DESC NULLS LAST`, sans plancher d'année.
 * - `top_rated` — `rating >= 8` ET `year >= année courante − 15` (le bruit
 *   des classiques peu votés et des titres anciens est écarté ; ~1 100
 *   titres éligibles), tri `rating DESC, year DESC`.
 * - `type:<T>` — `type = T`, tri `rating DESC NULLS LAST, year DESC`.
 * - `genre:<G>` — `genres ?| [G]` ET `rating >= 7` (même plancher que les
 *   compléments de recommandations), tri `rating DESC`.
 * - `year:<Y>` — `year = Y`, tri `rating DESC NULLS LAST`.
 * - `community` — titres présents dans au moins une bibliothèque, tri par
 *   nombre d'utilisateurs distincts DESC puis `rating DESC`. Aucune donnée
 *   personnelle : seul le compteur agrégé est utilisé.
 * - `hidden_gems` — `rating >= 8`, présents dans AU PLUS une bibliothèque
 *   ET peu recommandés par la communauté MangaUpdates (< 5 liens entrants
 *   dans `manga_recommendation`, même seuil de visibilité que les sleepers),
 *   tri `rating DESC, year DESC` : les pépites que (presque) personne ne suit
 *   ni ne recommande. Sur l'accueil, la déduplication (section servie en
 *   dernier) garantit qu'elles ne sont pas déjà dans `popular`/`top_rated`.
 *
 * Les index `idx_manga_rating`, `idx_manga_year`, `idx_manga_type`
 * (migration `1788220800000`) et `idx_manga_recommendation_recommended_mu_id`
 * portent ces tris et filtres.
 */
@Injectable()
export class HomeSectionQueryBuilder {
  /** Plancher de note des sections `top_rated` et `hidden_gems`. */
  static readonly TOP_RATING_FLOOR = 8.0;

  /** Plancher de note des sections par genre (aligné sur les recos). */
  static readonly GENRE_RATING_FLOOR = 7.0;

  /** `top_rated` : années couvertes (année courante − N). */
  static readonly TOP_RATED_YEAR_SPAN = 15;

  /** `hidden_gems` : au plus N utilisateurs suivent le titre. */
  static readonly HIDDEN_GEMS_MAX_LIBRARIES = 1;

  /** `hidden_gems` : moins de N liens de recommandation MU entrants. */
  static readonly HIDDEN_GEMS_VISIBILITY_THRESHOLD = 5;

  constructor(
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
  ) {}

  /** Requête complète (filtres + tri) d'une section, sans limite. */
  build(def: HomeSectionDef, now: Date): SelectQueryBuilder<Manga> {
    const qb = this.baseQuery();
    const currentYear = now.getFullYear();
    switch (def.kind) {
      case 'latest':
        return qb
          .andWhere('m.year >= :yearMin', { yearMin: currentYear - 1 })
          .orderBy('m.year', 'DESC')
          .addOrderBy('m.rating', 'DESC', 'NULLS LAST')
          .addOrderBy('m.total_chapters', 'DESC')
          .addOrderBy('m.created_at', 'DESC')
          .addOrderBy('m.id', 'DESC');
      case 'popular':
        return qb
          .andWhere('m.rating IS NOT NULL')
          .orderBy('m.rating', 'DESC')
          .addOrderBy('m.id', 'ASC');
      case 'top_rated':
        return qb
          .andWhere('m.rating >= :ratingFloor', {
            ratingFloor: HomeSectionQueryBuilder.TOP_RATING_FLOOR,
          })
          .andWhere('m.year >= :yearMin', {
            yearMin: currentYear - HomeSectionQueryBuilder.TOP_RATED_YEAR_SPAN,
          })
          .orderBy('m.rating', 'DESC')
          .addOrderBy('m.year', 'DESC')
          .addOrderBy('m.id', 'ASC');
      case 'type':
        return qb
          .andWhere('m.type = :type', { type: def.params.type })
          .orderBy('m.rating', 'DESC', 'NULLS LAST')
          .addOrderBy('m.year', 'DESC', 'NULLS LAST')
          .addOrderBy('m.id', 'ASC');
      case 'genre':
        return qb
          .andWhere('m.genres::jsonb ?| ARRAY[:...sectionGenres]', {
            sectionGenres: [def.params.genre],
          })
          .andWhere('m.rating >= :genreFloor', {
            genreFloor: HomeSectionQueryBuilder.GENRE_RATING_FLOOR,
          })
          .orderBy('m.rating', 'DESC')
          .addOrderBy('m.id', 'ASC');
      case 'year':
        return qb
          .andWhere('m.year = :year', { year: def.params.year })
          .orderBy('m.rating', 'DESC', 'NULLS LAST')
          .addOrderBy('m.id', 'ASC');
      case 'community':
        return qb
          .andWhere(
            'EXISTS (SELECT 1 FROM user_manga um WHERE um.manga_id = m.mu_id)',
          )
          .orderBy(
            '(SELECT COUNT(DISTINCT um.user_id) FROM user_manga um WHERE um.manga_id = m.mu_id)',
            'DESC',
          )
          .addOrderBy('m.rating', 'DESC', 'NULLS LAST')
          .addOrderBy('m.id', 'ASC');
      case 'hidden_gems':
        return qb
          .andWhere('m.rating >= :ratingFloor', {
            ratingFloor: HomeSectionQueryBuilder.TOP_RATING_FLOOR,
          })
          .andWhere(
            '(SELECT COUNT(DISTINCT um.user_id) FROM user_manga um WHERE um.manga_id = m.mu_id) <= :maxLibraries',
            { maxLibraries: HomeSectionQueryBuilder.HIDDEN_GEMS_MAX_LIBRARIES },
          )
          .andWhere(
            '(SELECT COUNT(*) FROM manga_recommendation mr WHERE mr.recommended_mu_id = m.mu_id) < :visibility',
            {
              visibility:
                HomeSectionQueryBuilder.HIDDEN_GEMS_VISIBILITY_THRESHOLD,
            },
          )
          .orderBy('m.rating', 'DESC')
          .addOrderBy('m.year', 'DESC', 'NULLS LAST')
          .addOrderBy('m.id', 'ASC');
    }
  }

  /** Filtres communs : cover présente, genres connus, aucun genre NSFW. */
  private baseQuery(): SelectQueryBuilder<Manga> {
    return this.mangaRepository
      .createQueryBuilder('m')
      .where('m.medium_cover_url IS NOT NULL')
      .andWhere('m.genres IS NOT NULL')
      .andWhere('NOT (m.genres::jsonb ?| ARRAY[:...nsfwGenres])', {
        nsfwGenres: NSFW_GENRES,
      });
  }
}
