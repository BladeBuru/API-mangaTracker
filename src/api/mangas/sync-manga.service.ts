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
        await this.mangasService.getMangaDetails(
          Number(manga.mu_id),
          manga.total_chapters,
        );
      } catch (err) {
        // Log the error but continue syncing
        console.error(`Error syncing manga mu_id=${manga.mu_id} :`, err);
      }
    }
    console.log('Manga synchronization complete!');
  }
}
