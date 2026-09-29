import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';

/** Base des endpoints « auteurs » de MangaUpdates. */
export const MU_AUTHORS_BASE_URL = 'https://api.mangaupdates.com/v1/authors';

/** Délai max d'un appel déclenché par un utilisateur qui attend l'écran. */
export const MU_AUTHOR_TIMEOUT_MS = 8_000;

/**
 * Accès HTTP aux fiches auteur MangaUpdates.
 *
 * Appels déclenchés par l'ouverture d'une page auteur : UNE tentative, sans
 * le backoff des jobs nocturnes (5 à 40 s d'attente seraient inacceptables
 * pour un écran), et c'est `AuthorsService` qui met en cache (24 h) pour
 * qu'une même fiche ne coûte qu'un appel par jour — « ne pas se faire
 * bannir » reste l'exigence n°1.
 *
 * Un 404 est une réponse normale (identifiant inconnu) → `null`.
 */
@Injectable()
export class MuAuthorsClient {
  constructor(private readonly http: HttpService) {}

  async fetchAuthor(authorId: number): Promise<unknown | null> {
    return this.call(() =>
      firstValueFrom(
        this.http.get(`${MU_AUTHORS_BASE_URL}/${authorId}`, {
          timeout: MU_AUTHOR_TIMEOUT_MS,
        }),
      ),
    );
  }

  async fetchAuthorSeries(authorId: number): Promise<unknown | null> {
    return this.call(() =>
      firstValueFrom(
        this.http.post(
          `${MU_AUTHORS_BASE_URL}/${authorId}/series`,
          { orderby: 'year' },
          { timeout: MU_AUTHOR_TIMEOUT_MS },
        ),
      ),
    );
  }

  private async call(
    request: () => Promise<{ data: unknown }>,
  ): Promise<unknown | null> {
    try {
      const { data } = await request();
      return data;
    } catch (err) {
      if ((err as AxiosError)?.response?.status === 404) return null;
      throw err;
    }
  }
}
