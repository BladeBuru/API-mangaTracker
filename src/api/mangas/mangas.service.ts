import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MangaQuickViewDto } from './dto/manga-quick-view.dto';
import { catchError, firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { MU_DETAIL_URL, MU_TRENDS_URL, NSFW_GENRES } from './constants';
import { HelperService } from './helper.service';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { Repository } from 'typeorm';

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

  async getMangaDetails(
    muId: number,
    currentTotalChapters = 0,
  ): Promise<MangaDetailsDto> {
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
        // Strategy: we keep the highest value for totalChapters
        total_chapters: Math.max(details.totalChapters, currentTotalChapters),
        completed: details.completed,
        associated: details.associated,
        genres: details.genres,
        type: details.type,
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
}
