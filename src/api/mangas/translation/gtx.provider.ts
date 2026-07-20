import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { TranslationProvider } from './translation-provider.interface';

export const GTX_API_URL =
  'https://translate.googleapis.com/translate_a/single';

/**
 * Taille max d'un chunk AVANT encodage URL. L'endpoint gtx est un GET :
 * une description MU longue encodée (~×3 en worst case UTF-8) peut dépasser
 * la limite d'URL (~8-16k selon les fronts). 3500 caractères laissent une
 * marge confortable.
 */
export const GTX_MAX_CHUNK_LENGTH = 3500;

/**
 * Découpe `text` en chunks de `maxLen` caractères max, en coupant sur les
 * frontières de phrase (ponctuation finale ou fin de ligne) pour ne pas
 * couper une phrase en deux — la traduction d'une demi-phrase est mauvaise.
 * Une phrase isolée plus longue que `maxLen` est hard-splittée (cas
 * dégénéré, jamais vu sur des descriptions MU réelles).
 */
export function splitOnSentenceBoundary(
  text: string,
  maxLen: number,
): string[] {
  if (text.length <= maxLen) return [text];

  // Une "phrase" = tout jusqu'à une ponctuation finale (./!/?) ou un saut
  // de ligne inclus, espaces suivants compris ; le dernier fragment sans
  // ponctuation finale est capturé par la 2ᵉ alternative.
  const sentences = text.match(/[^.!?\n]*[.!?\n]+\s*|[^.!?\n]+$/g) ?? [text];

  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const pieces: string[] = [];
    if (sentence.length > maxLen) {
      for (let i = 0; i < sentence.length; i += maxLen) {
        pieces.push(sentence.slice(i, i + maxLen));
      }
    } else {
      pieces.push(sentence);
    }
    for (const piece of pieces) {
      if (current.length > 0 && current.length + piece.length > maxLen) {
        chunks.push(current);
        current = '';
      }
      current += piece;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Provider Google Translate non officiel (`client=gtx`) — fallback
 * zéro-config quand DeepL n'a pas de clé ou échoue. Port serveur de
 * l'ancien `_translateWithGoogleTranslate` du front Flutter.
 *
 * Fragile par nature (endpoint non documenté, bannissable par IP) mais le
 * trafic serveur est minuscule : 1 appel par (manga, langue, changement de
 * description) grâce au cache `manga_translation`.
 */
@Injectable()
export class GtxProvider implements TranslationProvider {
  readonly name = 'gtx';

  private readonly logger = new Logger(GtxProvider.name);

  constructor(private readonly httpService: HttpService) {}

  async translate(text: string, targetLang: string): Promise<string | null> {
    try {
      const chunks = splitOnSentenceBoundary(text, GTX_MAX_CHUNK_LENGTH);
      const translatedChunks: string[] = [];
      for (const chunk of chunks) {
        const translated = await this.translateChunk(chunk, targetLang);
        // Un chunk raté = traduction partielle → on abandonne tout (le
        // caller renverra la description originale, jamais un mélange).
        if (translated === null) return null;
        translatedChunks.push(translated);
      }
      const joined = translatedChunks.join(' ').trim();
      return joined.length > 0 ? joined : null;
    } catch (err) {
      this.logger.warn(
        `gtx translate vers ${targetLang} en échec: ${
          (err as Error)?.message ?? err
        }`,
      );
      return null;
    }
  }

  private async translateChunk(
    chunk: string,
    targetLang: string,
  ): Promise<string | null> {
    const url =
      `${GTX_API_URL}?client=gtx&sl=en&tl=${encodeURIComponent(targetLang)}` +
      `&dt=t&q=${encodeURIComponent(chunk)}`;

    const { data } = await firstValueFrom(this.httpService.get<unknown[]>(url));

    // Format gtx : data[0] = [[segTraduit, segSource, ...], ...] — on
    // concatène les premiers éléments de chaque segment.
    const segments = Array.isArray(data?.[0]) ? (data[0] as unknown[]) : null;
    if (!segments) return null;

    const joined = segments
      .map((seg) =>
        Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '',
      )
      .join('');
    return joined.length > 0 ? joined : null;
  }
}
