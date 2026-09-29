import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { MuAuthorsClient } from './mu-authors.client';
import {
  mapMuAuthor,
  mapMuAuthorWorks,
  MuAuthorWork,
} from './mu-author.mapper';
import { AuthorDetailsDto, AuthorWorkDto } from './dto/author-details.dto';

/** Une fiche auteur change rarement : un appel MU par auteur et par jour. */
export const AUTHOR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Échec MU mémorisé brièvement : un auteur en panne ne martèle pas MU. */
export const AUTHOR_FAILURE_TTL_MS = 5 * 60 * 1000;
/** Borne mémoire du cache (entrées les plus anciennes évincées). */
export const AUTHOR_CACHE_MAX_ENTRIES = 2000;

type CacheEntry =
  | { kind: 'ok'; value: AuthorDetailsDto; expiresAt: number }
  | { kind: 'missing'; expiresAt: number }
  | { kind: 'failed'; expiresAt: number };

/**
 * Page auteur : mini bio + œuvres, depuis MangaUpdates (`/v1/authors/…`).
 *
 * - Cache mémoire 24 h par auteur, requêtes simultanées dédupliquées (une
 *   seule requête MU en vol par auteur), échecs mémorisés 5 min.
 * - Œuvres enrichies par le catalogue local (couverture, note, type) quand
 *   il les connaît ; les inconnues reçoivent une fiche minimale (même cycle
 *   « fiche minimale puis complétion » que le graphe de recommandations —
 *   la synchro nocturne et le proxy de couverture la complètent).
 * - Si la liste des œuvres échoue mais la fiche répond : fiche partielle
 *   (`worksComplete = false`) plutôt qu'une erreur.
 */
@Injectable()
export class AuthorsService {
  private readonly logger = new Logger(AuthorsService.name);
  private readonly cache = new Map<number, CacheEntry>();
  private readonly inFlight = new Map<number, Promise<AuthorDetailsDto>>();

  constructor(
    private readonly client: MuAuthorsClient,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
  ) {}

  async getAuthor(authorId: number): Promise<AuthorDetailsDto> {
    const cached = this.cache.get(authorId);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.kind === 'ok') return cached.value;
      if (cached.kind === 'missing') throw this.notFound(authorId);
      throw this.unavailable();
    }

    const pending = this.inFlight.get(authorId);
    if (pending) return pending;

    const request = this.load(authorId).finally(() =>
      this.inFlight.delete(authorId),
    );
    this.inFlight.set(authorId, request);
    return request;
  }

  private async load(authorId: number): Promise<AuthorDetailsDto> {
    const [infoResult, worksResult] = await Promise.allSettled([
      this.client.fetchAuthor(authorId),
      this.client.fetchAuthorSeries(authorId),
    ]);

    if (infoResult.status === 'rejected') {
      this.logger.warn(
        `Fiche auteur ${authorId} indisponible : ${infoResult.reason}`,
      );
      this.remember(authorId, {
        kind: 'failed',
        expiresAt: Date.now() + AUTHOR_FAILURE_TTL_MS,
      });
      throw this.unavailable();
    }

    const info = mapMuAuthor(infoResult.value);
    if (!info) {
      this.remember(authorId, {
        kind: 'missing',
        expiresAt: Date.now() + AUTHOR_FAILURE_TTL_MS,
      });
      throw this.notFound(authorId);
    }

    const worksComplete = worksResult.status === 'fulfilled';
    if (!worksComplete) {
      this.logger.warn(
        `Œuvres de l'auteur ${authorId} indisponibles : ${worksResult.reason}`,
      );
    }
    const rawWorks = worksComplete ? mapMuAuthorWorks(worksResult.value) : [];
    const works = await this.enrichWorks(rawWorks);

    const value: AuthorDetailsDto = {
      id: authorId,
      ...info,
      works,
      worksComplete,
    };
    this.remember(authorId, {
      kind: 'ok',
      value,
      // Fiche partielle : on retentera la liste des œuvres plus tôt.
      expiresAt:
        Date.now() +
        (worksComplete ? AUTHOR_CACHE_TTL_MS : AUTHOR_FAILURE_TTL_MS),
    });
    return value;
  }

  /** Couverture / note / type du catalogue local, fiches minimales sinon. */
  private async enrichWorks(works: MuAuthorWork[]): Promise<AuthorWorkDto[]> {
    if (works.length === 0) return [];
    const ids = works.map((w) => w.muId.toString());
    const known = await this.mangaRepository.find({
      where: { mu_id: In(ids) },
    });
    const byId = new Map(known.map((m) => [m.mu_id.toString(), m]));

    const missing = works.filter((w) => !byId.has(w.muId.toString()));
    if (missing.length > 0) {
      await this.mangaRepository
        .createQueryBuilder()
        .insert()
        .into(Manga)
        .values(
          missing.map((w) => ({
            mu_id: w.muId.toString(),
            title: w.title,
            year: w.year,
            genres: w.genres.length > 0 ? w.genres : null,
          })),
        )
        .orIgnore()
        .execute()
        .catch((err) =>
          this.logger.warn(`Fiches minimales des œuvres : ${err}`),
        );
    }

    return works
      .map((w) => {
        const m = byId.get(w.muId.toString());
        const rating = m?.rating != null ? Number(m.rating) : null;
        return {
          muId: w.muId,
          title: m?.title ?? w.title,
          year: w.year ?? m?.year ?? null,
          mediumCoverUrl: m?.medium_cover_url ?? null,
          rating: rating != null && rating > 0 ? rating : null,
          type: m?.type ?? null,
          genres: w.genres.length > 0 ? w.genres : m?.genres ?? [],
        };
      })
      .sort(
        (a, b) =>
          (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title),
      );
  }

  private remember(authorId: number, entry: CacheEntry): void {
    if (this.cache.size >= AUTHOR_CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(authorId);
    this.cache.set(authorId, entry);
  }

  private notFound(authorId: number): NotFoundException {
    return new NotFoundException(`Auteur ${authorId} introuvable`);
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException(
      'Fiche auteur momentanément indisponible',
    );
  }
}
