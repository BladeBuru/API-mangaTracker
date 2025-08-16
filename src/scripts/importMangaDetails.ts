#!/usr/bin/env ts-node
// remove dupes : node -e "const fs=require('fs'); const ids=JSON.parse(fs.readFileSync('muIds.json','utf8')); const uniq=[...new Set(ids)]; fs.writeFileSync('muIds.json', JSON.stringify(uniq, null, 2)); console.log('Removed', ids.length-uniq.length, 'duplicates');"
import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { MangasService } from '@/api/mangas/mangas.service';
import { MangaDetailsDto } from '@/api/mangas/dto/manga-details.dto';
import { Manga } from '@/api/mangas/manga.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as fs } from 'fs';

function formatDbError(err: any) {
  const e = err?.driverError || err;
  const parts: string[] = [];
  if (e?.message) parts.push(`message="${e.message}"`);
  if (e?.code) parts.push(`code=${e.code}`);
  if (e?.detail) parts.push(`detail="${e.detail}"`);
  if (e?.schema) parts.push(`schema=${e.schema}`);
  if (e?.table) parts.push(`table=${e.table}`);
  if (e?.column) parts.push(`column=${e.column}`);
  if (e?.dataType) parts.push(`dataType=${e.dataType}`);
  if (e?.constraint) parts.push(`constraint=${e.constraint}`);
  if (e?.where) parts.push(`where="${e.where}"`);
  if (e?.routine) parts.push(`routine=${e.routine}`);
  if (err?.query) parts.push(`query=${JSON.stringify(err.query)}`);
  if (err?.parameters) {
    try {
      parts.push(`parameters=${JSON.stringify(err.parameters)}`);
    } catch {}
  }
  return parts.join(' | ');
}

function formatHttpError(err: any) {
  const status = err?.response?.status;
  const statusText = err?.response?.statusText;
  const data = err?.response?.data;
  const msg = err?.message || String(err);
  const pieces: string[] = [];
  pieces.push(`message="${msg}"`);
  if (status) pieces.push(`status=${status}`);
  if (statusText) pieces.push(`statusText="${statusText}"`);
  if (data) {
    try {
      pieces.push(`data=${JSON.stringify(data)}`);
    } catch {
      pieces.push(`data=<unserializable>`);
    }
  }
  return pieces.join(' | ');
}

async function appendInvalidId(file: string, muId: number) {
  try {
    const arr = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Array.isArray(arr)) {
      if (!arr.includes(muId)) arr.push(muId);
      await fs.writeFile(file, JSON.stringify(arr, null, 2), 'utf8');
      return;
    }
  } catch {}
  await fs.writeFile(file, JSON.stringify([muId], null, 2), 'utf8');
}

async function bootstrap() {
  const appCtx = await NestFactory.createApplicationContext(AppModule);
  const service = appCtx.get(MangasService);
  const repo = appCtx.get<Repository<Manga>>(getRepositoryToken(Manga));

  const filePath = process.argv[2] || './muIds.json';
  const invalidPath = process.argv[3] || './invalid_muIds.json';
  const muIds: number[] = JSON.parse(await fs.readFile(filePath, 'utf8'));

  const baseDelay = 250;
  const jitter = 500;
  const maxRetries = 3;
  const maxConsecutiveFails = 5;
  let consecutiveFails = 0;

  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  for (const muId of muIds) {
    const existing = await repo.findOne({ where: { mu_id: String(muId) } });
    if (existing) {
      console.log(`↩️  Manga ${muId} déjà en base, skip API`);
      continue;
    }

    let attempt = 0;
    let success = false;
    let apiAttempted = false;

    while (attempt <= maxRetries) {
      try {
        apiAttempted = true;

        const dto: MangaDetailsDto = await service.getMangaDetails(muId);
        const entity = Manga.fromMU(dto);
        await repo.save(entity);

        console.log(`✅ Manga ${muId} importé`);
        success = true;
        consecutiveFails = 0;
        break;
      } catch (err: any) {
        attempt++;

        if (err?.code === '23505') {
          console.warn(`⚠️  Manga ${muId} déjà en base (unique), ignoré`);
          success = true;
          consecutiveFails = 0;
          break;
        }

        if (err?.code === '22P02') {
          console.warn(
            `🚫 Manga ${muId} ignoré (erreur 22P02: format invalide)`,
          );
          await appendInvalidId(invalidPath, muId);
          success = true;
          break;
        }

        const status = err?.response?.status;
        if ((status === 429 || status === 503) && attempt <= maxRetries) {
          const backoff = baseDelay * Math.pow(2, attempt);
          console.warn(
            `⚠️ ${status} pour ${muId}, retry #${attempt} après ${backoff}ms`,
          );
          await sleep(backoff);
          continue;
        }

        const dbInfo = formatDbError(err);
        const httpInfo = formatHttpError(err);
        const extra = [dbInfo, httpInfo].filter(Boolean).join(' || ');
        console.error(
          `❌ Échec ${muId} (tentative ${attempt}/${maxRetries}) : ${
            extra || err?.message || err
          }`,
        );

        break;
      }
    }

    // Si échec complet après retries => ajouter dans invalid
    if (!success && apiAttempted) {
      await appendInvalidId(invalidPath, muId);
      consecutiveFails++;
      if (consecutiveFails >= maxConsecutiveFails) {
        console.error(
          `🚨 ${consecutiveFails} échecs consécutifs atteints. Arrêt du script.`,
        );
        process.exit(1);
      }
    }

    if (apiAttempted) {
      const raw = baseDelay + (Math.random() * 2 - 1) * jitter;
      const delay = Math.max(0, Math.round(raw));
      await sleep(delay);
    }
  }

  console.log('🏁 importMangaDetails terminé');
  await appCtx.close();
}

bootstrap().catch((err) => {
  const msg =
    formatDbError(err) || formatHttpError(err) || err?.message || String(err);
  console.error('❌ Script importMangaDetails échoué :', msg);
  process.exit(1);
});
