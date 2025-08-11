#!/usr/bin/env ts-node

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { MangasService } from '@/api/mangas/mangas.service';
import { MangaDetailsDto } from '@/api/mangas/dto/manga-details.dto';
import { Manga } from '@/api/mangas/manga.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as fs } from 'fs';

async function bootstrap() {
  const appCtx = await NestFactory.createApplicationContext(AppModule);
  const service = appCtx.get(MangasService);
  const repo = appCtx.get<Repository<Manga>>(getRepositoryToken(Manga));

  const filePath = process.argv[2] || './muIds.json';
  const muIds: number[] = JSON.parse(await fs.readFile(filePath, 'utf8'));

  const baseDelay = 5; // ~1 req/s
  const jitter = 500; // ±500 ms
  const maxRetries = 3;
  const maxConsecutiveFails = 5;
  let consecutiveFails = 0;

  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  for (const muId of muIds) {
    let attempt = 0;
    let success = false;

    while (attempt <= maxRetries) {
      try {
        // Récupère tous les champs détaillés
        const dto: MangaDetailsDto = await service.getMangaDetails(muId);

        // Convertit DTO en entité via la méthode statique fromMU
        const entity = Manga.fromMU(dto);
        await repo.save(entity);

        console.log(`✅ Manga ${muId} importé`);
        success = true;
        consecutiveFails = 0;
        break;
      } catch (err: any) {
        attempt++;
        const status = err.response?.status;
        if (status === 429 && attempt <= maxRetries) {
          const backoff = baseDelay * Math.pow(2, attempt);
          console.warn(
            `⚠️ 429 pour ${muId}, retry #${attempt} après ${backoff}ms`,
          );
          await sleep(backoff);
          continue;
        }
        console.error(
          `❌ Échec ${muId} (tentative ${attempt}/${maxRetries}) :`,
          err.message || err,
        );
        break;
      }
    }

    if (!success) {
      consecutiveFails++;
      if (consecutiveFails >= maxConsecutiveFails) {
        console.error(
          `🚨 ${consecutiveFails} échecs consécutifs atteints. Arrêt du script.`,
        );
        process.exit(1);
      }
    }

    // Throttle entre 1 req/s ± jitter
    const raw = baseDelay + (Math.random() * 2 - 1) * jitter;
    const delay = Math.max(0, Math.round(raw));
    await sleep(delay);
  }

  console.log('🏁 importMangaDetails terminé');
  await appCtx.close();
}

bootstrap().catch((err) => {
  console.error('❌ Script importMangaDetails échoué :', err);
  process.exit(1);
});
