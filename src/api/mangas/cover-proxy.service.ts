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
import { MU_DETAIL_URL } from './constants';
import { Manga } from './manga.entity';
import { UpdateMangaService } from './update-manga.service';

/**
 * Proxy de couvertures (Phase 4 — refactoré en 302 redirect).
 *
 * **Stratégie révisée** : plutôt que de fetch upstream MU côté serveur
 * Node (qui peut être bloqué par MU CDN selon User-Agent, géo IP, ou
 * réseau du serveur API), on **redirige (302) le client** vers l'URL MU.
 * Le navigateur (ou `cached_network_image` côté Flutter mobile) gère le
 * fetch et le cache.
 *
 * Avantages :
 *  - Pas de fetch Node-side → fin du problème User-Agent / TLS / DNS.
 *  - Browser cache natif (et NPMplus peut cacher la redirection 302).
 *  - Si l'URL upstream MU est 404, le client retombe sur `refresh-cover`
 *    (fallback existant côté Flutter via `RefreshableMangaImage`).
 *  - Drastiquement moins de bande passante côté serveur API.
 *
 * Le service expose uniquement la résolution `muId → URL stable` ; le
 * controller fait le `res.redirect(302, url)`.
 */

export type CoverSize = 'small' | 'medium' | 'large';

@Injectable()
export class CoverProxyService {
  private readonly logger = new Logger(CoverProxyService.name);

  constructor(
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    private readonly updateMangaService: UpdateMangaService,
    private readonly httpService: HttpService,
  ) {}

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
