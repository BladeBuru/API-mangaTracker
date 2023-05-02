import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { RetrieveMangaTrendsDto } from './dto/retrieve-manga-trends.dto';
import { catchError, firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { MU_DETAIL_URL, MU_TRENDS_URL } from './constants';
import { HelperService } from './helper.service';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Manga } from './manga.entity';

@Injectable()
export class MangasService {
  constructor(
    private readonly httpService: HttpService,
    private readonly helperService: HelperService,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
  ) {}

  private readonly logger = new Logger(MangasService.name);

  async retrieveMangaTrends(
    limit?: number,
    offset?: number,
  ): Promise<RetrieveMangaTrendsDto[]> {
    const url = this.helperService.formatRequestForMalApi(MU_TRENDS_URL, {
      limit: limit !== undefined ? limit.toString() : undefined,
      offset: offset !== undefined ? offset.toString() : undefined,
    });
    const payload = {
      orderby: 'rating',
      perpage: limit,
      page: offset,
    };
    const { data } = await firstValueFrom(
      this.httpService.post<RetrieveMangaTrendsDto[]>(url, payload).pipe(
        catchError((error: AxiosError) => {
          this.logger.error(error.response.data);
          throw 'Impossible to retrieve trends from external service';
        }),
      ),
    );
    const nbMangas = data['results'].length;
    const mangas: RetrieveMangaTrendsDto[] = new Array(nbMangas);
    for (let i = 0; i < nbMangas; i++) {
      mangas[i] = RetrieveMangaTrendsDto.fromMu(data['results'][i]);
    }
    return mangas;
  }

  async getMangaDetails(malId: number): Promise<MangaDetailsDto> {
    const url = MU_DETAIL_URL.concat(malId.toString());

    const { data } = await firstValueFrom(
      this.httpService.get<any>(url).pipe(
        catchError((error: AxiosError) => {
          this.logger.error(error.response.data);
          throw 'Impossible to retrieve manga details from external service';
        }),
      ),
    );

    return MangaDetailsDto.fromMU(data);
  }

  async saveMangaToLibrary(malId: number): Promise<Manga> {
    const mangaDto = await this.getMangaDetails(malId);
    const manga = Manga.fromMU(mangaDto);

    this.logger.debug(JSON.stringify(manga));
    //await this.mangaRepository.save(manga);
    return manga;
  }
}
