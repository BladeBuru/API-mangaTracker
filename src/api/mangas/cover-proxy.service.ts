import {
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import { Repository } from 'typeorm';
import { promises as fs } from 'fs';
import * as path from 'path';
import { MU_DETAIL_URL } from './constants';
import { Manga } from './manga.entity';
import { UpdateMangaService } from './update-manga.service';

/**
 * Proxy de couvertures — mode hybride 302 / stream (hotfix-v0-10-1 US-2).
 *
 * **Mode `redirect` (défaut, mobile)** : on redirige (302) le client vers
 * l'URL MU — le fetch Node-side peut être bloqué par le CDN MU (User-Agent,
 * géo IP), le navigateur/`cached_network_image` gère le fetch et le cache.
 *
 * **Mode `stream` (Flutter Web)** : sur le web, CanvasKit fetch les bytes
 * de l'image → le navigateur suit le 302 vers `cdn.mangaupdates.com` qui
 * n'envoie PAS de header CORS → image bloquée. En mode stream, l'API fetch
 * les bytes elle-même (User-Agent navigateur), les met en cache disque
 * (`COVERS_CACHE_DIR`, défaut `./uploads/covers`) et les sert directement —
 * même origine que l'API → CORS OK.
 *
 * Échec du fetch upstream en mode stream → le controller retombe sur le
 * 302 (dégradation douce — pas de 500).
 */

export type CoverSize = 'small' | 'medium' | 'large';

/** Bytes + content-type d'une cover servie en mode stream. */
export interface CoverPayload {
  data: Buffer;
  contentType: string;
}

/** Extensions gérées par le cache disque, mappées par content-type. */
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const CONTENT_TYPE_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_CONTENT_TYPE).map(([ct, ext]) => [ext, ct]),
);

/**
 * User-Agent navigateur réaliste pour le fetch upstream : le CDN MU bloque
 * certains User-Agents serveur (raison historique du refactor 302).
 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

@Injectable()
export class CoverProxyService {
  private readonly logger = new Logger(CoverProxyService.name);

  /**
   * Dossier du cache disque des covers (mode stream). Monté sur un volume
   * NAS en prod via `COVERS_CACHE_DIR`. Si le dossier n'est pas créable
   * (droits), le cache est désactivé silencieusement (pass-through).
   */
  private readonly cacheDir =
    process.env.COVERS_CACHE_DIR ??
    path.join(process.cwd(), 'uploads', 'covers');

  private cacheDirReady: Promise<boolean> | null = null;

  constructor(
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    private readonly updateMangaService: UpdateMangaService,
    private readonly httpService: HttpService,
  ) {}

  /**
   * Sert les bytes d'une cover (mode `stream`, hotfix-v0-10-1 US-2) :
   *  1. cache disque → hit : servi sans re-fetch upstream ;
   *  2. miss : résolution URL (logique 302 existante) + fetch bytes avec
   *     User-Agent navigateur + écriture disque best-effort.
   *
   * @throws si l'upstream est inaccessible — le controller retombe en 302.
   */
  async streamCover(muId: number, size: CoverSize): Promise<CoverPayload> {
    const cached = await this.readDiskCache(muId, size);
    if (cached) return cached;

    const url = await this.resolveUpstreamUrl(muId, size);
    const payload = await this.fetchImageBytes(url);
    await this.writeDiskCache(muId, size, payload);
    return payload;
  }

  /** Fetch les bytes d'une image upstream (timeout 8s, UA navigateur). */
  private async fetchImageBytes(url: string): Promise<CoverPayload> {
    const response = await firstValueFrom(
      this.httpService.get<ArrayBuffer>(url, {
        timeout: 8000,
        responseType: 'arraybuffer',
        headers: { 'User-Agent': BROWSER_UA, Accept: 'image/*' },
      }),
    );
    const contentType =
      (response.headers?.['content-type'] as string | undefined) ??
      'image/jpeg';
    return { data: Buffer.from(response.data), contentType };
  }

  /** Lecture du cache disque — null si miss ou cache indisponible. */
  private async readDiskCache(
    muId: number,
    size: CoverSize,
  ): Promise<CoverPayload | null> {
    if (!(await this.ensureCacheDir())) return null;
    for (const [ext, contentType] of Object.entries(CONTENT_TYPE_BY_EXT)) {
      try {
        const data = await fs.readFile(this.cachePath(muId, size, ext));
        return { data, contentType };
      } catch {
        // Fichier absent pour cette extension — on essaie la suivante.
      }
    }
    return null;
  }

  /** Écriture best-effort : un échec disque ne casse jamais la réponse. */
  private async writeDiskCache(
    muId: number,
    size: CoverSize,
    payload: CoverPayload,
  ): Promise<void> {
    if (!(await this.ensureCacheDir())) return;
    const ext = EXT_BY_CONTENT_TYPE[payload.contentType] ?? 'jpg';
    try {
      await fs.writeFile(this.cachePath(muId, size, ext), payload.data);
    } catch (err) {
      this.logger.warn(
        `Cover disk cache write failed muId=${muId}: ${err?.message ?? err}`,
      );
    }
  }

  private cachePath(muId: number, size: CoverSize, ext: string): string {
    return path.join(this.cacheDir, `${muId}-${size}.${ext}`);
  }

  /** Crée le dossier de cache au premier usage (résultat mémoïsé). */
  private ensureCacheDir(): Promise<boolean> {
    if (!this.cacheDirReady) {
      this.cacheDirReady = fs
        .mkdir(this.cacheDir, { recursive: true })
        .then(() => true)
        .catch((err) => {
          this.logger.warn(
            `Covers cache dir unavailable (${this.cacheDir}): ${
              err?.message ?? err
            } — disk cache disabled`,
          );
          return false;
        });
    }
    return this.cacheDirReady;
  }

  /**
   * Résout l'URL upstream à utiliser pour un manga.
   *
   * Si aucune URL n'est cachée en BDD pour ce manga, on déclenche un
   * `refreshCovers` pour récupérer une URL fraîche via l'API MU, puis on
   * retourne. Si même après refresh on n'a rien d'utilisable → 404.
   *
   * @throws {NotFoundException} si manga inconnu ou aucune URL trouvable.
   */
  async resolveUpstreamUrl(muId: number, size: CoverSize): Promise<string> {
    const manga = await this.mangaRepository.findOneBy({
      mu_id: muId.toString(),
    });

    // Cas 1 : manga déjà en BDD → on retourne l'URL cachée si dispo.
    if (manga) {
      const cached = this.pickUrl(manga, size);
      if (cached) return cached;
    }

    // Cas 2 : manga en BDD mais sans URL → tenter un refresh côté refresh
    // service (qui save en BDD pour la prochaine fois).
    if (manga) {
      try {
        await this.updateMangaService.refreshCovers(muId);
        const refreshed = await this.mangaRepository.findOneBy({
          mu_id: muId.toString(),
        });
        const refreshedUrl = refreshed ? this.pickUrl(refreshed, size) : null;
        if (refreshedUrl) return refreshedUrl;
      } catch (err) {
        this.logger.warn(
          `refreshCovers failed for muId=${muId}: ${err?.message ?? err}`,
        );
        // Continue vers le fallback live MU plutôt que de 404 sec.
      }
    }

    // **Cas 3 (2026-05-19)** : manga ABSENT de la BDD (cas typique des
    // listings Tendances / Populaires / Nouveautés où on n'ajoute pas
    // chaque manga retourné par MU à la BDD locale). Avant on retournait
    // 404 sec — désormais on fetch en live l'image URL depuis MU detail
    // API et on redirige. Pas de save en BDD pour rester stateless et
    // ne pas polluer la table avec des mangas non-suivis.
    try {
      const liveUrl = await this.fetchCoverFromMuLive(muId);
      if (liveUrl) return liveUrl;
    } catch (err) {
      this.logger.warn(
        `Live fetch cover failed for muId=${muId}: ${err?.message ?? err}`,
      );
    }

    throw new NotFoundException(`No cover available for muId=${muId}`);
  }

  /**
   * Fetch live l'URL de cover d'un manga depuis l'API détail MangaUpdates,
   * SANS le persister en BDD. Utilisé en fallback pour le proxy quand le
   * manga n'est pas (encore) suivi en local.
   *
   * Timeout 5s — si MU est lent, mieux vaut 404 rapide qu'un loader infini.
   */
  private async fetchCoverFromMuLive(muId: number): Promise<string | null> {
    const url = `${MU_DETAIL_URL}${muId}`;
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<any>(url, { timeout: 5000 }),
      );
      // Format MU 2026-05 : image.url.original (flat) OR image.url.original (idem)
      const original = data?.image?.url?.original as string | undefined;
      const thumb = data?.image?.url?.thumb as string | undefined;
      return original ?? thumb ?? null;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.debug(`MU live fetch muId=${muId}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Sélectionne l'URL appropriée selon la taille demandée.
   *
   * **Observation empirique (2026-05-17)** : les URLs MU `cdn.mangaupdates.com/image/thumb/iXXX.jpg`
   * retournent 404 systématiquement alors que `cdn.mangaupdates.com/image/iXXX.png` marche.
   * Le path `/thumb/` est cassé côté MU pour les mangas indexés via leur API.
   *
   * Stratégie : **toujours préférer `medium_cover_url`** (l'URL "original" qui
   * marche). Le navigateur peut downscale via `width`/`height` côté `<img>`.
   * On retombe sur `small_cover_url` seulement en dernier recours.
   */
  private pickUrl(manga: Manga, size: CoverSize): string | null {
    // Préférence absolue : medium (original) qui marche, peu importe la taille
    // demandée. `small_cover_url` (thumb) sert juste de fallback.
    return manga.medium_cover_url ?? manga.small_cover_url ?? null;
  }
}
