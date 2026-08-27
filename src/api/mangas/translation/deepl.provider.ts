import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { TranslationProvider } from './translation-provider.interface';

export const DEEPL_API_URL = 'https://api-free.deepl.com/v2/translate';

/**
 * Mapping code primaire 2 lettres → target_lang DeepL.
 * `pt` est mappé explicitement (DeepL exige PT-PT ou PT-BR, le `PT` nu est
 * déprécié).
 */
const DEEPL_TARGET_LANG: Record<string, string> = {
  fr: 'FR',
  de: 'DE',
  es: 'ES',
  pt: 'PT-PT',
  ja: 'JA',
  ko: 'KO',
};

interface DeeplResponse {
  translations?: { text?: string }[];
}

/**
 * Provider DeepL API Free — primaire quand `DEEPL_API_KEY` est défini.
 * Sans clé, le provider est inactif (`translate` → null immédiat) et le
 * `DescriptionTranslationService` bascule sur gtx.
 */
@Injectable()
export class DeeplProvider implements TranslationProvider {
  readonly name = 'deepl';

  private readonly logger = new Logger(DeeplProvider.name);
  private readonly apiKey: string | undefined;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
  ) {
    this.apiKey = configService.get<string>('DEEPL_API_KEY');
  }

  /** Actif uniquement si une clé DeepL est configurée */
  isEnabled(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.trim().length > 0;
  }

  async translate(text: string, targetLang: string): Promise<string | null> {
    if (!this.isEnabled()) return null;

    const target = DEEPL_TARGET_LANG[targetLang];
    if (!target) return null;

    try {
      const { data } = await firstValueFrom(
        this.httpService.post<DeeplResponse>(
          DEEPL_API_URL,
          { text: [text], source_lang: 'EN', target_lang: target },
          {
            headers: { Authorization: `DeepL-Auth-Key ${this.apiKey}` },
          },
        ),
      );
      const translated = data?.translations?.[0]?.text;
      return typeof translated === 'string' && translated.length > 0
        ? translated
        : null;
    } catch (err) {
      // 456 = quota mensuel DeepL épuisé, 429 = rate limit — dans tous les
      // cas on log et on laisse la cascade basculer sur gtx.
      this.logger.warn(
        `DeepL translate vers ${targetLang} en échec: ${
          (err as Error)?.message ?? err
        }`,
      );
      return null;
    }
  }
}
