// src/scripts/scrapeTopRatedMuIds.ts

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { MangasService } from '@/api/mangas/mangas.service';
import { promises as fs } from 'fs';

async function bootstrap(): Promise<void> {
  const appCtx = await NestFactory.createApplicationContext(AppModule);
  const service = appCtx.get(MangasService);

  // chemin vers le fichier de sortie passé en argument, sinon './muIds.json'
  const filePath = process.argv[2] || './muIds1.json';

  const muIds: number[] = [];
  const perPage = 100;
  const totalPages = 100;
  const baseDelay = 1000; // ~1 req/s
  const jitter = 500; // ±500 ms
  const maxRetries = 3;
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  for (let page = 1; page <= totalPages; page++) {
    let attempt = 0;

    while (true) {
      try {
        const mangas = await service.retrieveManga('rating', perPage, page);
        muIds.push(...mangas.map((m) => m.muId));
        console.log(`✅ Page ${page} récupérée (${mangas.length} items)`);
        break;
      } catch (err: any) {
        attempt++;
        const status429 =
          err?.response?.status === 429 || String(err).includes('429');
        if (status429 && attempt <= maxRetries) {
          const backoff = baseDelay * Math.pow(2, attempt);
          console.warn(
            `⚠️ 429 reçu pour page ${page}, retry #${attempt} après ${backoff}ms`,
          );
          await sleep(backoff);
          continue;
        }
        console.error(`❌ Échec page ${page}:`, err.message || err);
        // on abandonne tout le script en cas d'erreur non retriable
        process.exitCode = 1;
        await appCtx.close();
        return;
      }
    }

    if (page < totalPages) {
      const delay = baseDelay + (Math.random() * 2 - 1) * jitter;
      await sleep(delay);
    }
  }

  await fs.writeFile(filePath, JSON.stringify(muIds, null, 2), 'utf8');
  console.log(
    `🎉 Scraping terminé : ${muIds.length} muId(s) écrits dans ${filePath}`,
  );

  await appCtx.close();
}

bootstrap().catch((err) => {
  console.error('Script scrapeTopRatedMuIds échoué :', err);
  process.exit(1);
});
