import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import { MangaTranslation } from '../manga-translation.entity';
import { DeeplProvider } from './deepl.provider';
import { GtxProvider } from './gtx.provider';
import { TranslationProvider } from './translation-provider.interface';

/**
 * Langues cibles supportées. `en` n'y figure pas : la source MU est en
 * anglais → passthrough (la description originale est renvoyée telle
 * quelle, sans appel provider ni ligne en base).
 */
export const SUPPORTED_TARGET_LANGS: readonly string[] = [
  'fr',
  'de',
  'es',
  'pt',
  'ja',
  'ko',
];

/** Timeout dur par défaut sur la traduction synchrone (1er visiteur) */
export const DEFAULT_TRANSLATION_TIMEOUT_MS = 4000;

/**
 * Durée du negative-cache : après un échec total des providers pour un couple
 * (manga, langue), on ne retente pas (et on ne repaie donc pas le timeout de
 * {@link DEFAULT_TRANSLATION_TIMEOUT_MS}) pendant cette fenêtre.
 */
export const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Traduction des descriptions manga côté serveur (Chantier A).
 *
 * Service dédié — ne PAS fusionner dans `MangasService` (déjà au-dessus de
 * la limite des 400 lignes).
 *
 * Stratégie :
 * 1. Cache Postgres `manga_translation` clé (mu_id, language), invalidé par
 *    `source_hash` (sha256 de la description MU live).
 * 2. Cache PÉRIMÉ (hash différent) → stale-while-revalidate : on sert la
 *    traduction périmée IMMÉDIATEMENT et on re-traduit en arrière-plan (le
 *    visiteur ne retombe pas sur l'anglais pendant la re-traduction).
 * 3. Aucun cache → cascade providers (DeepL si clé, sinon gtx) bornée par un
 *    timeout dur (`TRANSLATION_TIMEOUT_MS`, défaut 4 s). Timeout/échec →
 *    `null` (le controller renvoie l'original) mais la promesse continue en
 *    arrière-plan et upserte pour le visiteur suivant.
 * 4. Negative-cache court ({@link NEGATIVE_CACHE_TTL_MS}) : après un échec
 *    total, on ne repaie pas le timeout à chaque requête (skip ~5 min).
 * 5. Dédup in-flight : une seule traduction simultanée par (manga, langue).
 */
@Injectable()
export class DescriptionTranslationService {
  private readonly logger = new Logger(DescriptionTranslationService.name);
  private readonly timeoutMs: number;

  /** Dédup in-flight : "<muId>:<lang>" → promesse de traduction en cours */
  private readonly inFlight = new Map<string, Promise<string | null>>();

  /**
   * Negative-cache : "<muId>:<lang>" → timestamp (ms) du dernier échec total.
   * Une entrée plus récente que {@link NEGATIVE_CACHE_TTL_MS} court-circuite
   * la traduction (évite de repayer le timeout providers à chaque requête).
   */
  private readonly negativeCache = new Map<string, number>();

  constructor(
    @InjectRepository(MangaTranslation)
    private readonly translationRepository: Repository<MangaTranslation>,
    private readonly deeplProvider: DeeplProvider,
    private readonly gtxProvider: GtxProvider,
    configService: ConfigService,
  ) {
    const configured = Number(
      configService.get<string>('TRANSLATION_TIMEOUT_MS'),
    );
    this.timeoutMs =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_TRANSLATION_TIMEOUT_MS;
  }

  /**
   * Extrait le sous-tag primaire du header `Accept-Language`.
   * Ex. : `fr-FR,fr;q=0.9` → `fr` ; `pt-BR` → `pt` ; absent/invalide → null.
   */
  parsePrimaryLang(acceptLanguage?: string): string | null {
    if (!acceptLanguage) return null;
    const first = acceptLanguage.split(',')[0]?.split(';')[0]?.trim();
    if (!first) return null;
    const primary = first.split('-')[0].toLowerCase();
    return /^[a-z]{2,3}$/.test(primary) ? primary : null;
  }

  /**
   * Retourne la description traduite pour (`muId`, `lang`), ou `null` si :
   * - `lang` est absent, `en`, ou hors langues supportées (passthrough) ;
   * - la traduction échoue ou dépasse le timeout ET aucune traduction (même
   *   périmée) n'est disponible.
   *
   * Stale-while-revalidate : une traduction périmée est servie immédiatement
   * et re-traduite en arrière-plan. Ne rejette jamais — une traduction ratée
   * ne produit pas de 5xx.
   */
  async getTranslatedDescription(
    muId: number,
    sourceDescription: string,
    lang: string | null,
  ): Promise<string | null> {
    const normalized = (lang ?? '').trim().toLowerCase();
    if (!SUPPORTED_TARGET_LANGS.includes(normalized)) return null;
    if (!sourceDescription || sourceDescription.trim().length === 0) {
      return null;
    }

    const hash = createHash('sha256').update(sourceDescription).digest('hex');

    const existing = await this.translationRepository.findOneBy({
      mu_id: muId.toString(),
      language: normalized,
    });
    if (existing && existing.source_hash === hash) {
      // Hit : hash identique → zéro appel externe.
      return existing.translated_description;
    }

    const key = `${muId}:${normalized}`;

    // Negative-cache : un échec récent → on ne repaie pas le timeout. On sert
    // le stale s'il existe, sinon null (→ description originale côté controller).
    if (this.isNegativelyCached(key)) {
      return existing?.translated_description ?? null;
    }

    // Lance (ou réutilise) la traduction. Le résultat alimente le
    // negative-cache (échec) ou le purge (succès).
    let job = this.inFlight.get(key);
    if (!job) {
      job = this.translateAndPersist(muId, normalized, sourceDescription, hash)
        .then((result) => {
          if (result === null) this.negativeCache.set(key, Date.now());
          else this.negativeCache.delete(key);
          return result;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, job);
    }

    // Stale-while-revalidate : on a une traduction PÉRIMÉE → on la sert tout
    // de suite (pas d'anglais transitoire), la re-traduction se fait en fond.
    if (existing) {
      return existing.translated_description;
    }

    // Aucun cache : traduction synchrone bornée par le timeout. Au-delà, null
    // (→ description originale) mais `job` continue et upserte pour le suivant.
    return this.raceWithTimeout(job, this.timeoutMs);
  }

  /**
   * `true` si un échec de traduction pour cette clé est en cache depuis moins
   * de {@link NEGATIVE_CACHE_TTL_MS}. Purge l'entrée expirée au passage.
   */
  private isNegativelyCached(key: string): boolean {
    const failedAt = this.negativeCache.get(key);
    if (failedAt === undefined) return false;
    if (Date.now() - failedAt > NEGATIVE_CACHE_TTL_MS) {
      this.negativeCache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Cascade providers (DeepL si clé configurée, puis gtx) + upsert du
   * résultat. Résout toujours (jamais de rejet) : `null` = échec total.
   */
  private async translateAndPersist(
    muId: number,
    lang: string,
    sourceDescription: string,
    sourceHash: string,
  ): Promise<string | null> {
    const providers: TranslationProvider[] = this.deeplProvider.isEnabled()
      ? [this.deeplProvider, this.gtxProvider]
      : [this.gtxProvider];

    for (const provider of providers) {
      let translated: string | null = null;
      try {
        translated = await provider.translate(sourceDescription, lang);
      } catch (err) {
        // Les providers ne devraient jamais rejeter (contrat) — ceinture
        // et bretelles pour garantir "jamais de 5xx pour une traduction".
        this.logger.warn(
          `Provider ${provider.name} a rejeté pour ${muId}:${lang}: ${
            (err as Error)?.message ?? err
          }`,
        );
      }
      if (translated) {
        await this.upsertTranslation(muId, lang, sourceHash, translated).catch(
          (err) =>
            this.logger.warn(
              `Upsert traduction ${muId}:${lang} en échec: ${
                (err as Error)?.message ?? err
              }`,
            ),
        );
        return translated;
      }
    }

    this.logger.warn(
      `Aucun provider n'a pu traduire la description de ${muId} en ${lang}`,
    );
    return null;
  }

  /** Upsert idempotent sur l'index UNIQUE (mu_id, language) */
  private async upsertTranslation(
    muId: number,
    lang: string,
    sourceHash: string,
    translatedDescription: string,
  ): Promise<void> {
    await this.translationRepository
      .createQueryBuilder()
      .insert()
      .into(MangaTranslation)
      .values({
        mu_id: muId.toString(),
        language: lang,
        source_hash: sourceHash,
        translated_description: translatedDescription,
      })
      .orUpdate(
        ['source_hash', 'translated_description', 'updated_at'],
        ['mu_id', 'language'],
      )
      .execute();
  }

  /**
   * Course promesse vs timeout. Ne rejette jamais : échec ou timeout →
   * `null`. Le timer est toujours nettoyé (pas de handle qui traîne).
   */
  private raceWithTimeout(
    promise: Promise<string | null>,
    timeoutMs: number,
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(null);
        });
    });
  }
}
