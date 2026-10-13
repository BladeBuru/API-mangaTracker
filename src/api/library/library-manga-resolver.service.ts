import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Manga } from '@/api/mangas/manga.entity';
import { MangasService } from '@/api/mangas/mangas.service';

/** Âge au-delà duquel une fiche locale est rafraîchie depuis MU (6 h). */
const STALE_AFTER_MS = 6 * 3600 * 1000;

/**
 * Résout la ligne `manga` locale servant aux écritures de bibliothèque
 * (ajout, progression, statut), en la créant ou la rafraîchissant depuis
 * MangaUpdates au besoin.
 *
 * Extrait de `LibraryService` (au-delà des 400 lignes) : « garantir une
 * fiche locale exploitable » est une responsabilité distincte de « gérer la
 * bibliothèque », et c'est elle qui porte la tolérance aux pannes MU.
 */
@Injectable()
export class LibraryMangaResolverService {
  private readonly logger = new Logger(LibraryMangaResolverService.name);

  constructor(
    private readonly mangasService: MangasService,
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
  ) {}

  /**
   * Fiche locale du manga, créée depuis MU si absente, rafraîchie si
   * périmée (> 6 h) ou incomplète (`completed` inconnu).
   *
   * Sans ligne locale, une panne MU remonte (404 / 503) : il n'y a rien à
   * servir. Avec une ligne locale, le rafraîchissement est best-effort.
   */
  async resolve(muId: number): Promise<Manga> {
    const mangaEntity = await this.mangasService.returnMangaIfExist(
      muId.toString(),
    );

    if (mangaEntity === null) {
      await this.mangaRepository.save(
        Manga.fromMU(await this.mangasService.getMangaDetails(muId)),
      );
    } else if (
      mangaEntity.updated_at < new Date(Date.now() - STALE_AFTER_MS) ||
      mangaEntity.completed === null
    ) {
      await this.refreshStaleManga(muId);
    }

    return await this.mangasService.returnMangaIfExist(muId.toString());
  }

  /**
   * Rafraîchit une fiche locale périmée depuis MangaUpdates.
   *
   * Best-effort : la ligne locale suffit pour servir une écriture de
   * l'utilisateur (progression, statut). Une panne MU (timeout, 5xx, 429)
   * ne doit plus faire échouer `PUT /library/chapter` — on garde la ligne
   * locale et on journalise ; le prochain appel retentera.
   */
  private async refreshStaleManga(muId: number): Promise<void> {
    try {
      const mangaDetails = Manga.fromMU(
        await this.mangasService.getMangaDetails(muId),
      );

      // A-5 : GREATEST inconditionnel — total_chapters ne régresse jamais
      // (regex status MU peu fiable, cf. decisions.md). completed écrasé.
      // Bascule « à jour » → « en cours » : déjà déclenchée par
      // `getMangaDetails` ci-dessus (même `newTotal`) — rien à faire ici.
      await this.mangaRepository
        .createQueryBuilder()
        .update(Manga)
        .set({
          completed: mangaDetails.completed,
          total_chapters: () => 'GREATEST(total_chapters, :newTotal)',
        })
        .setParameter('newTotal', Number(mangaDetails.total_chapters) || 0)
        .where('mu_id = :muId', { muId: muId.toString() })
        .execute();
    } catch (err) {
      this.logger.warn(
        `Rafraîchissement MangaUpdates du manga ${muId} impossible — ligne locale conservée : ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }
}
