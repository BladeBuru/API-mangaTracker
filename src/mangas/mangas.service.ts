import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MangaQuickViewDto } from './dto/manga-quick-view';
import { catchError, firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import { MU_DETAIL_URL, MU_TRENDS_URL } from './constants';
import { HelperService } from './helper.service';
import { MangaDetailsDto } from './dto/manga-details.dto';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { UserManga } from './user-manga.entity';
import User from 'src/user/user.entity';
import { UserService } from 'src/user/user.service';

@Injectable()
export class MangasService {
  constructor(
    private readonly httpService: HttpService,
    private readonly userService: UserService,
    private readonly helperService: HelperService,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(UserManga)
    private readonly userMangaRepository: Repository<UserManga>,
  ) {}

  private readonly logger = new Logger(MangasService.name);

  async retrieveMangaTrendsOrNews(
    filter: string,
    limit?: number,
    offset?: number,
  ): Promise<MangaQuickViewDto[]> {
    const url = this.helperService.formatRequestForMalApi(MU_TRENDS_URL, {
      limit: limit !== undefined ? limit.toString() : undefined,
      offset: offset !== undefined ? offset.toString() : undefined,
    });
    const payload = {
      orderby: filter === 'top' ? 'rating' : 'year',
      exclude_genre: ['Mature'],
      perpage: limit,
      page: offset,
    };
    const { data } = await firstValueFrom(
      this.httpService.post<MangaQuickViewDto[]>(url, payload).pipe(
        catchError((error: AxiosError) => {
          this.logger.error(error.response.data);
          throw 'Impossible to retrieve trends from external service';
        }),
      ),
    );
    const nbMangas = data['results'].length;
    const mangas: MangaQuickViewDto[] = new Array(nbMangas);
    for (let i = 0; i < nbMangas; i++) {
      mangas[i] = MangaQuickViewDto.fromMu(data['results'][i]);
    }
    return mangas;
  }

  async getMangaDetails(malId: number): Promise<MangaDetailsDto> {
    const url = MU_DETAIL_URL.concat(malId.toString());

    const { data } = await firstValueFrom(
      this.httpService.get<any>(url).pipe(
        catchError((error: AxiosError) => {
          this.logger.error(error.response.status);
          throw 'Impossible to retrieve manga details from external service';
        }),
      ),
    );
    console.log(JSON.stringify(data));
    return MangaDetailsDto.fromMU(data);
  }

  async saveMangaToLibrary(
    muId: number,
    userId: number,
  ): Promise<MangaDetailsDto> {
    const mangaDto = await this.getMangaDetails(muId);
    const manga = Manga.fromMU(mangaDto);

    const userEntity = await this.userService.returnUserIfExist(userId);

    if (userEntity === null)
      throw new NotFoundException(`User with id ${userId} does not exist`);

    let mangaEntity = await this.returnMangaIfExist(muId.toString());

    if (mangaEntity === null) {
      mangaEntity = await this.mangaRepository.save(manga);
    }

    const userMangaEntityInDB = await this.userMangaRepository.findOneBy({
      user: userEntity,
      manga: mangaEntity,
    });

    if (userMangaEntityInDB !== null)
      throw new BadRequestException('Manga already saved');

    const userManga = new UserManga();
    userManga.user = userEntity;
    userManga.manga = mangaEntity;
    await this.userMangaRepository.save(userManga);
    return mangaDto;
  }

  async getUserMangas(userId: number): Promise<MangaQuickViewDto[]> {
    const userMangas = await this.mangaRepository
      .createQueryBuilder('manga')
      .leftJoinAndSelect(
        UserManga,
        'userManga',
        'userManga.manga_id = manga.id',
      )
      .leftJoinAndSelect(User, 'user', 'user.id = userManga.user_id')
      .where('user.id = :id', { id: userId })
      .getRawMany();

    console.log(JSON.stringify(userMangas));

    const nbMangas = userMangas.length;
    const userMangasQuickView: MangaQuickViewDto[] = new Array(nbMangas);
    for (let i = 0; i < nbMangas; i++) {
      userMangasQuickView[i] = MangaQuickViewDto.fromLibrary(userMangas[i]);
    }
    return userMangasQuickView;
  }

  async returnMangaIfExist(mangaId: string): Promise<Manga> {
    const mangaEntity = await this.mangaRepository.findOneBy({
      muId: mangaId,
    });

    return mangaEntity;
  }
}
