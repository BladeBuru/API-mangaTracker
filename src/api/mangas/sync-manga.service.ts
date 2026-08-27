import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { Repository } from 'typeorm';
import { MangasService } from './mangas.service';
import { buildProtectedColumnsUpdate } from './manga-completeness.util';

@Injectable()
export class MangaSyncService {
  private readonly logger = new Logger(MangaSyncService.name);

  constructor(
    @InjectRepository(Manga)
    private readonly mangaRepository: Repository<Manga>,
    private readonly mangasService: MangasService,
  ) {}

  async syncAllMangasWithApi() {
    const allMangas = await this.mangaRepository.find();
    for (const manga of allMangas) {
      try {
        const details = await this.mangasService.getMangaDetails(
          Number(manga.mu_id),
        );
        // Stratégie : on garde la valeur la plus élevée pour totalChapters
        const newTotalChapters = Math.max(
          details.totalChapters,
          manga.total_chapters,
        );
        // 2026-08-28 (complétude des données) : `year`, `rating` et les covers
        // passent par `buildProtectedColumnsUpdate` — un détail MU sans note
        // (titre peu voté) ou sans année ne remet plus la colonne à NULL.
        // Même doctrine que `getMangaDetails` et l'upsert catalogue.
        await this.mangaRepository.update(
          { id: manga.id },
          {
            title: details.title,
            total_chapters: newTotalChapters,
            completed: details.completed,
            associated: details.associated,
            ...buildProtectedColumnsUpdate(details),
          },
        );
      } catch (err) {
        // Log l'erreur mais continue la synchro
        this.logger.warn(
          `Erreur lors de la synchro du manga mu_id=${manga.mu_id} : ${
            (err as Error)?.message ?? err
          }`,
        );
      }
    }
    this.logger.log(
      `Synchronisation des mangas terminée (${allMangas.length} titre(s) traité(s))`,
    );
  }
}
