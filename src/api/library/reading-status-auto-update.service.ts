import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserManga } from '@/api/mangas/user-manga.entity';
import { ReadingStatus } from './reading-status.enum';

/**
 * Sous-requête : total officiel ACTUEL du manga de la ligne `user_manga`
 * en cours d'évaluation. Lu au moment de l'UPDATE (et non passé en
 * paramètre) pour que la bascule reste correcte même si un autre chemin a
 * fait monter le total entre-temps — `total_chapters` est monotone
 * croissant (invariant A-5), la valeur en base est donc toujours la bonne.
 */
const CURRENT_TOTAL_SUBQUERY =
  'SELECT m.total_chapters FROM manga m WHERE m.mu_id = "user_manga"."manga_id"';

/**
 * Bascule automatique « à jour » → « en cours ».
 *
 * Règle produit : *« si on détecte un nouveau chapitre sur un manga que j'ai
 * marqué "à jour", c'est qu'on n'est plus à jour : on est "en cours" »*.
 *
 * Ce service est LA source de vérité de cette règle : il tourne côté API,
 * donc y compris quand l'application est fermée (sync nocturne des sorties).
 * Il est appelé par tous les chemins qui font **augmenter**
 * `manga.total_chapters` :
 *   - `CatalogReleasesService.applyUpdates` (sorties MU, cron 02:00) ;
 *   - `ChapterReportService.consolidate` (signalement communautaire) ;
 *   - `MangasService.getMangaDetails` (rafraîchissement des détails — couvre
 *     aussi `LibraryService.checkManga`, `UpdateMangaService` et
 *     `MangaSyncService`, qui passent tous par lui).
 *
 * Périmètre volontairement strict :
 *   - seul `caughtUp` bascule. `completed` (manga terminé ET lu en entier) et
 *     `readLater` ne bougent jamais ;
 *   - la bascule n'est déclenchée QUE sur une hausse effective du total. Un
 *     simple rafraîchissement sans nouveau chapitre ne touche à rien : un
 *     utilisateur qui s'est déclaré « à jour » volontairement en retard sur le
 *     total MU (scans FR en retard sur les raws, par ex.) n'est pas ramené en
 *     boucle à « en cours » toutes les 6 h.
 */
@Injectable()
export class ReadingStatusAutoUpdateService {
  private readonly logger = new Logger(ReadingStatusAutoUpdateService.name);

  constructor(
    @InjectRepository(UserManga)
    private readonly userMangaRepository: Repository<UserManga>,
  ) {}

  /**
   * À appeler juste APRÈS une hausse de `manga.total_chapters` pour `muId`.
   *
   * Une seule requête UPDATE ensembliste (jamais de boucle par utilisateur) :
   * toutes les entrées « à jour » de ce manga dont la progression est
   * désormais en retard sur le total passent « en cours », `lastUpdated`
   * mis à jour (l'entrée remonte donc en tête de la bibliothèque).
   *
   * Best-effort : une erreur BDD est journalisée et renvoie 0 — le total,
   * lui, est déjà écrit et reste la source de vérité ; l'appelant (fiche
   * détail, job nocturne, signalement) ne doit pas échouer à cause de cet
   * effet secondaire.
   *
   * @returns Nombre de lignes basculées.
   */
  async flipCaughtUpToReading(muId: number | string): Promise<number> {
    try {
      const result = await this.userMangaRepository
        .createQueryBuilder()
        .update(UserManga)
        .set({ readingStatus: ReadingStatus.Reading, lastUpdated: new Date() })
        .where('manga_id = :muId', { muId: String(muId) })
        .andWhere('"readingStatus" = :caughtUp', {
          caughtUp: ReadingStatus.CaughtUp,
        })
        .andWhere(`user_read_chapters < (${CURRENT_TOTAL_SUBQUERY})`)
        .execute();

      const flipped = Number(result?.affected ?? 0);
      if (flipped > 0) {
        this.logger.log(
          `Manga ${muId} : ${flipped} entrée(s) « à jour » basculée(s) en « en cours » (nouveaux chapitres)`,
        );
      }
      return flipped;
    } catch (err) {
      this.logger.error(
        `Manga ${muId} : échec de la bascule auto « à jour » → « en cours » : ${
          (err as Error)?.message ?? err
        }`,
      );
      return 0;
    }
  }
}
