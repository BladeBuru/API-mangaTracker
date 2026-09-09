import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import { fetchWithMuBackoff } from '@/api/mangas/mu-backoff';
import {
  DiscoveredReader,
  extractDiscoveredReaders,
  extractListEntries,
  extractPublicLists,
  MuListSearchBody,
  MuPublicList,
  MuSimilarBody,
  PublicListRef,
  RawSignalRow,
} from './mu-lists.mapper';
import { ReaderListType } from './reader-signal-weights';

/** Base des endpoints « listes » de MangaUpdates. */
export const MU_LISTS_BASE_URL = 'https://api.mangaupdates.com/v1/lists';

/**
 * `perpage` maximum accepté par `POST /lists/public/{uid}/search/{lid}`.
 * Mesuré le 2026-09-09 : 1000 est honoré (écho `per_page: 1000`), 2000 et
 * 5000 sont silencieusement coercés à 25. Ne jamais dépasser cette valeur —
 * l'écho `per_page` est le seul indicateur de coercition, et une coercition
 * non détectée transformerait une liste de 900 titres en 25.
 */
export const MU_LIST_MAX_PER_PAGE = 1000;

/** Résultat d'une page de liste publique. */
export interface ListPage {
  rows: RawSignalRow[];
  totalHits: number;
  /** `per_page` renvoyé par MU — révèle une éventuelle coercition. */
  perPageEcho: number;
}

/**
 * Accès HTTP aux trois endpoints « listes publiques » de MangaUpdates.
 *
 * Sans authentification : vérifié le 2026-09-09, les trois répondent 200 en
 * anonyme. Le service ne porte AUCUNE logique de budget, de verrou ni de
 * cadence — c'est le job (`ReaderSignalCollectService`) qui les détient,
 * pour qu'un seul endroit compte les requêtes envoyées à MU.
 *
 * Le backoff MU partagé (`fetchWithMuBackoff`) est appliqué ici : 429 et 5xx
 * sont réessayés 4 fois (5/10/20/40 s), tout autre code est propagé.
 *
 * ## 404 attendus
 *
 * MU répond 404 — et non « liste vide » — dans deux cas parfaitement
 * normaux : une série que personne n'a rangée dans le type demandé, et une
 * liste dont le propriétaire a retiré la publication entre le `GET /lists`
 * et le `POST /search`. Ces 404 sont convertis en résultat vide, jamais en
 * erreur : les compter comme des échecs déclencherait le disjoncteur sur un
 * fonctionnement nominal.
 */
@Injectable()
export class MuListsClient {
  private readonly logger = new Logger(MuListsClient.name);

  /** Injectable pour les tests (évite les vrais timers du backoff). */
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(private readonly httpService: HttpService) {}

  /**
   * Étape de DÉCOUVERTE : les lecteurs ayant rangé `muId` dans une liste de
   * type `listType`.
   *
   * Plafonné à 100 lecteurs par MU, triés par `user_id` croissant — donc
   * **toujours les mêmes 100 comptes les plus anciens** pour un couple
   * (série, type) donné. Biais assumé et documenté : re-sonder la même
   * cellule ne découvre rien de neuf, c'est pourquoi le curseur de
   * découverte avance série par série au lieu de repasser sur les têtes.
   */
  async fetchSimilarReaders(
    listType: ReaderListType,
    muId: string,
  ): Promise<DiscoveredReader[]> {
    const url = `${MU_LISTS_BASE_URL}/similar/${listType}/${muId}`;
    const body = await this.get<MuSimilarBody>(url, `similar ${listType}`);
    return body === null ? [] : extractDiscoveredReaders(body);
  }

  /** Étape d'EXTRACTION, 1/2 : les listes publiques d'un lecteur. */
  async fetchPublicLists(userId: string): Promise<PublicListRef[]> {
    const url = `${MU_LISTS_BASE_URL}/public/${userId}`;
    const body = await this.get<MuPublicList[]>(url, 'public lists');
    return body === null ? [] : extractPublicLists(body);
  }

  /**
   * Étape d'EXTRACTION, 2/2 : une page du contenu d'une liste publique.
   *
   * @param perPage Doit rester ≤ `MU_LIST_MAX_PER_PAGE`, sinon MU coerce
   *                silencieusement à 25.
   */
  async fetchListPage(
    userId: string,
    listId: string,
    listType: ReaderListType,
    page: number,
    perPage: number,
  ): Promise<ListPage> {
    const url = `${MU_LISTS_BASE_URL}/public/${userId}/search/${listId}`;
    const payload = {
      perpage: Math.min(perPage, MU_LIST_MAX_PER_PAGE),
      page,
    };
    const body = await fetchWithMuBackoff(
      () => this.postOrNull<MuListSearchBody>(url, payload),
      `list page ${page}`,
      this.logger,
      this.sleep,
    );
    if (body === null) return { rows: [], totalHits: 0, perPageEcho: 0 };
    return {
      rows: extractListEntries(body, listType),
      totalHits: Number(body.total_hits ?? 0) || 0,
      perPageEcho: Number(body.per_page ?? 0) || 0,
    };
  }

  /** GET avec backoff MU ; `null` sur 404 (cas nominal, cf. en-tête). */
  private async get<T>(url: string, label: string): Promise<T | null> {
    return fetchWithMuBackoff(
      async () => {
        try {
          const { data } = await firstValueFrom(this.httpService.get<T>(url));
          return data ?? null;
        } catch (err) {
          if (isNotFound(err)) return null;
          throw err;
        }
      },
      label,
      this.logger,
      this.sleep,
    );
  }

  /** POST ; `null` sur 404. Le backoff est appliqué par l'appelant. */
  private async postOrNull<T>(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<T | null> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.post<T>(url, payload),
      );
      return data ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return (err as AxiosError)?.response?.status === 404;
}
