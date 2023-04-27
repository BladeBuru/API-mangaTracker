import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { RetrieveMangaTrendsDto } from './dto/retrieve-manga-trends.dto';
import { catchError, firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { MAL_TRENDS_URL } from './constants';

@Injectable()
export class MangasService {
  constructor(private readonly httpService: HttpService) {}

  private readonly logger = new Logger(MangasService.name);

  async retrieveMangaTrends(): Promise<RetrieveMangaTrendsDto[]> {
    const { data } = await firstValueFrom(
      this.httpService.get<RetrieveMangaTrendsDto[]>(MAL_TRENDS_URL).pipe(
        catchError((error: AxiosError) => {
          this.logger.error(error.response.data);
          throw 'Impossible to retrieve trends from external service';
        }),
      ),
    );
    const nbMangas = data['data'].length;
    const mangas: RetrieveMangaTrendsDto[] = new Array(nbMangas);
    for (let i = 0; i < nbMangas; i++) {
      mangas[i] = RetrieveMangaTrendsDto.fromMal(data['data'][i]);
    }
    this.logger.debug(mangas);
    return mangas;
  }
}
