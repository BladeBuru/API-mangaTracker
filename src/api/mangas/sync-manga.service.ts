import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Manga } from './manga.entity';
import { Repository } from 'typeorm';
import { MangasService } from './mangas.service';

@Injectable()
export class MangaSyncService {
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
        await this.mangaRepository.update(
          { id: manga.id },
          {
            title: details.title,
            year: details.year,
            small_cover_url: details.smallCoverUrl,
            medium_cover_url: details.mediumCoverUrl,
            rating: details.rating,
            total_chapters: newTotalChapters,
            completed: details.completed,
            associated: details.associated,
          },
        );
      } catch (err) {
        // Log l'erreur mais continue la synchro
        console.error(
          `Erreur lors de la synchro du manga mu_id=${manga.mu_id} :`,
          err,
        );
      }
    }
    console.log('Synchronisation des mangas terminée !');
  }
}
