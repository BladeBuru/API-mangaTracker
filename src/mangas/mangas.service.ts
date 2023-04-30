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

  async retrieveMangaTrends(
    limit?: string,
    offset?: string,
  ): Promise<RetrieveMangaTrendsDto[]> {
    this.logger.debug(limit);
    this.logger.debug(offset);
    const url = this.formatRequestForMalApi(MAL_TRENDS_URL, {
      limit: limit,
      offset: offset,
    });
    const { data } = await firstValueFrom(
      this.httpService.get<RetrieveMangaTrendsDto[]>(url).pipe(
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
    return mangas;
  }

  formatRequestForMalApi(
    url: string,
    parameters: { [key: string]: string },
  ): string {
    let formattedRequest = url;
    let firstParameter = true;

    for (const key in parameters) {
      const currentParam = parameters[key];
      if (typeof currentParam !== 'undefined') {
        formattedRequest = formattedRequest.concat(
          (firstParameter ? '?' : '&') + key + '=' + currentParam,
        );
        firstParameter = false;
      }
    }
    this.logger.debug(formattedRequest);
    return formattedRequest;
  }
}
