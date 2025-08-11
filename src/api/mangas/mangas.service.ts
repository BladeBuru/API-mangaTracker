import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MangaQuickViewDto } from './dto/manga-quick-view.dto';
import { catchError, firstValueFrom, map } from 'rxjs';
import { AxiosError } from 'axios';
import { MU_DETAIL_URL, MU_TRENDS_URL, NSFW_GENRES } from './constants';
import { HelperService } from './helper.service';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { Repository } from 'typeorm';

//----------------- Dépendances/Types pour Advanced Search -----------------
type YesNo = 'yes' | 'no' | 'both';

export interface MuSearchParams {
  search?: string;
  added_by?: number;
  stype?: string; // ex: 'title' | 'author' | 'artist'
  licensed?: YesNo | string;
  type?: string[]; // ex: ['Manga','Manhwa','Manhua']
  year?: string; // ex: '2015' | '2015-2020'
  filter_types?: string[];
  category?: string[];
  pubname?: string;
  filter?: string; // ex: 'scanlated'
  filters?: string[]; // ex: ['scanlated']
  list?: string;
  page?: number; // 1-based selon ton usage actuel
  perpage?: number;
  letter?: string; // préfixe
  genre?: string[]; // à inclure
  exclude_genre?: string[]; // à exclure
  orderby?: string; // ex: 'score'
  pending?: boolean;
  include_rank_metadata?: boolean;
  exclude_filtered_genres?: boolean;
}

type MuSearchResponse = { results: unknown[]; total?: number };

function isEmpty(val: unknown): boolean {
  if (val == null) return true;
  if (typeof val === 'string') return val.trim().length === 0;
  if (Array.isArray(val)) return val.length === 0;
  return false;
}

function cleanPayload<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isEmpty(v)) continue;
    out[k] = v;
  }
  return out as T;
}

// -------------------------------------------------------------------------

@Injectable()
export class MangasService {
  constructor(
    private readonly httpService: HttpService,
    private readonly helperService: HelperService,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
  ) {}

  private readonly logger = new Logger(MangasService.name);

  async retrieveManga(
    filter: string,
    limit?: number,
    offset?: number,
  ): Promise<MangaQuickViewDto[]> {
    const url = this.helperService.formatRequestForMuApi(MU_TRENDS_URL, {
      limit: limit !== undefined ? limit.toString() : undefined,
      offset: offset !== undefined ? offset.toString() : undefined,
    });
    const payload = {
      orderby: filter,
      exclude_genre: NSFW_GENRES,
      perpage: limit,
      page: offset,
    };
    const { data } = await firstValueFrom(
      this.httpService.post<MangaQuickViewDto[]>(url, payload).pipe(
        catchError((error: AxiosError) => {
          this.logger.error(error.code);
          throw `Impossible to retrieve mangas with filter ${filter} from external service`;
        }),
      ),
    );

    return MangaQuickViewDto.arrayFromMu(data['results']);
  }

  async getMangaDetails(muId: number): Promise<MangaDetailsDto> {
    const url = MU_DETAIL_URL.concat(muId.toString());

    const { data } = await firstValueFrom(
      this.httpService.get<any>(url).pipe(
        catchError((error: AxiosError) => {
          this.logger.error(`${error.response.status}: ${error.response.data}`);
          if (error.response.status === 404) {
            throw new NotFoundException(
              `Manga with id ${muId} cannot be found`,
            );
          } else {
            throw new ServiceUnavailableException(
              'Impossible to retrieve manga details from external API. Service might be unavailable',
            );
          }
        }),
      ),
    );
    const details = MangaDetailsDto.fromMU(data);
    await this.mangaRepository.update(
      { mu_id: muId.toString() },
      {
        title: details.title,
        year: details.year,
        small_cover_url: details.smallCoverUrl,
        medium_cover_url: details.mediumCoverUrl,
        rating: details.rating,
        total_chapters: details.totalChapters,
        completed: details.completed,
        associated: details.associated,
      },
    );
    return details;
  }

  async returnMangaIfExist(muId: string): Promise<Manga> {
    return await this.mangaRepository.findOneBy({
      mu_id: muId,
    });
  }

  async searchManga(searchPattern: string, limit: number, offset: number) {
    const payload = {
      search: searchPattern,
      perpage: limit,
      page: offset,
      exclude_genre: NSFW_GENRES,
    };
    const { data } = await firstValueFrom(
      this.httpService.post<MangaQuickViewDto[]>(MU_TRENDS_URL, payload).pipe(
        catchError((error: AxiosError) => {
          this.logger.error(error.code);
          throw `Impossible to retrieve mangas with search pattern ${searchPattern} from external service`;
        }),
      ),
    );

    return MangaQuickViewDto.arrayFromMu(data['results']);
  }

  async searchMangaAdvanced(
    params: Partial<MuSearchParams>,
    opts?: { limit?: number; page?: number; mergeNsfwExclusion?: boolean },
  ): Promise<MangaQuickViewDto[]> {
    const limit = Math.max(1, opts?.limit ?? params.perpage ?? 100);
    const page = Math.max(1, opts?.page ?? params.page ?? 1);

    // Valeurs par défaut sûres
    const defaults: MuSearchParams = {
      stype: 'title',
      orderby: 'score',
      include_rank_metadata: true,
      exclude_filtered_genres: true,
      perpage: limit,
      page,
    };

    // Fusion des genres exclus: NSFW + fournis
    const exclude_genre = (() => {
      const base = Array.isArray(params.exclude_genre)
        ? params.exclude_genre
        : [];
      if (opts?.mergeNsfwExclusion === false) return base;
      const set = new Set<string>([...NSFW_GENRES, ...base]);
      return Array.from(set);
    })();

    const payload: MuSearchParams = cleanPayload({
      ...defaults,
      ...params,
      perpage: limit,
      page,
      exclude_genre,
    });

    const body: MuSearchResponse = await firstValueFrom(
      this.httpService.post<MuSearchResponse>(MU_TRENDS_URL, payload).pipe(
        map((res) => res.data),
        catchError((error: AxiosError) => {
          this.logger.error(
            `MU search failed: ${error.code} ${
              error.message
            } payload=${JSON.stringify(payload)}`,
          );
          throw new Error(
            'Impossible to retrieve mangas from external service',
          );
        }),
      ),
    );

    return MangaQuickViewDto.arrayFromMu(body.results ?? []);
  }
}
