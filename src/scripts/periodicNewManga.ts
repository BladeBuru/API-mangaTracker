#!/usr/bin/env ts-node

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { MangasService } from '@/api/mangas/mangas.service';
import { Manga } from '@/api/mangas/manga.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { NSFW_GENRES } from '@/api/mangas/constants';

const client = axios.create({
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

const SERIES_SEARCH_URL = 'https://api.mangaupdates.com/v1/series/search';

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

const isRetryable = (err: any) =>
  RETRYABLE_STATUS.has(err?.response?.status) ||
  RETRYABLE_CODES.has(err?.code) ||
  String(err?.message || '').includes('socket hang up');

async function postWithRetry(
  url: string,
  payload: any,
  label: string,
  maxRetries = 5,
  baseDelay = 1000,
) {
  let attempt = 0;
  console.log(
    `[HTTP] POST ${label} -> ${url} payload keys=${Object.keys(payload).join(
      ',',
    )}`,
  );
  while (true) {
    try {
      const t0 = Date.now();
      const res = await client.post(url, payload);
      const dt = Date.now() - t0;
      console.log(`[HTTP] ${label} OK ${res.status} in ${dt}ms`);
      return res.data;
    } catch (err: any) {
      attempt++;
      const st = err?.response?.status;
      const code = err?.code;
      const msg = err?.message;
      console.warn(
        `[HTTP] ${label} FAIL #${attempt} status=${st ?? '-'} code=${
          code ?? '-'
        } msg=${msg ?? '-'}`,
      );
      if (attempt > maxRetries || !isRetryable(err)) throw err;
      const backoff = baseDelay * Math.pow(2, attempt);
      console.warn(`[HTTP] ${label} retry in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

async function bootstrap() {
  console.log(`=== Periodic Update (series only) ===`);

  const appCtx = await NestFactory.createApplicationContext(AppModule);
  const service = appCtx.get(MangasService);
  const repo = appCtx.get<Repository<Manga>>(getRepositoryToken(Manga));

  const perPage = 100;
  const baseDelay = 1000; // ~1 req/s
  const jitter = 500;
  const maxRetries = 3;
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const throttle = async (why: string) => {
    const raw = baseDelay + (Math.random() * 2 - 1) * jitter;
    const d = Math.max(0, Math.round(raw));
    console.log(`[THROTTLE] ${why} waiting ${d}ms`);
    await sleep(d);
  };

  const counters = {
    seriesPages: 0,
    seriesItemsSeen: 0,
    seriesNew: 0,
    seriesDupes: 0,
    seriesStopOn3Dupes: false,
    insertedNew: 0,
    updatedNew: 0,
    retries429: 0,
  };

  // upsert par muId (get details + save)
  async function upsertMuId(muId: number) {
    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        console.log(`[UPSERT] muId=${muId} -> fetching details`);
        const dto = await service.getMangaDetails(muId);
        const entity = Manga.fromMU(dto);

        const existing = await repo.findOne({
          where: { mu_id: muId.toString() },
        });
        const action = existing ? 'UPDATE' : 'INSERT';
        if (existing) entity.id = existing.id;

        const saved = await repo.save(entity);
        console.log(
          `[UPSERT] ${action} OK muId=${muId} title="${dto.title}" id=${
            saved.id ?? '-'
          } totalCh=${dto.totalChapters} rating=${dto.rating}`,
        );

        if (existing) counters.updatedNew++;
        else counters.insertedNew++;
        return true;
      } catch (err: any) {
        attempt++;
        const status = err?.response?.status;
        const msg = err?.message || '-';
        console.warn(
          `[UPSERT] muId=${muId} attempt=${attempt}/${maxRetries} status=${
            status ?? '-'
          } msg=${msg}`,
        );
        if (status === 429 && attempt <= maxRetries) {
          counters.retries429++;
          const backoff = baseDelay * Math.pow(2, attempt);
          console.warn(`[UPSERT] muId=${muId} 429 backoff ${backoff}ms`);
          await sleep(backoff);
          continue;
        }
        console.error(`[UPSERT] ABORT muId=${muId} reason=${msg}`);
        return false;
      }
    }
    return false;
  }

  // 1) Nouvelles séries (orderby date_added) — arrêt après 3 doublons d’affilée
  const newSeriesMuIds: number[] = [];
  let page = 1;
  let consecutiveDupes = 0;

  while (true) {
    counters.seriesPages++;
    let attempt = 0,
      pageOk = false;
    console.log(
      `[SERIES] page=${page} perpage=${perPage} exclude_nsfw=${
        Array.isArray(NSFW_GENRES) ? NSFW_GENRES.length : 'yes'
      }`,
    );
    while (attempt <= maxRetries && !pageOk) {
      try {
        const payload = {
          orderby: 'date_added',
          perpage: perPage,
          page,
          exclude_genre: NSFW_GENRES,
        };
        const data = await postWithRetry(
          SERIES_SEARCH_URL,
          payload,
          `series page=${page}`,
        );
        const results: any[] = Array.isArray(data?.results) ? data.results : [];
        console.log(`[SERIES] page=${page} results=${results.length}`);

        if (results.length === 0) {
          pageOk = true;
          break;
        }

        for (const it of results) {
          const muId = Number(it?.record?.series_id ?? it?.series_id ?? 0);
          counters.seriesItemsSeen++;
          if (!muId) {
            console.warn('[SERIES] skip item without series_id');
            continue;
          }

          const exists = await repo.findOne({
            where: { mu_id: muId.toString() },
          });
          if (exists) {
            consecutiveDupes++;
            counters.seriesDupes++;
            console.log(
              `[SERIES] duplicate muId=${muId} consecutiveDupes=${consecutiveDupes}`,
            );
            if (consecutiveDupes >= 3) {
              counters.seriesStopOn3Dupes = true;
              pageOk = true;
              break;
            }
            continue;
          }

          consecutiveDupes = 0;
          newSeriesMuIds.push(muId);
          counters.seriesNew++;
          console.log(`[SERIES] NEW muId=${muId}`);
        }

        pageOk = true;
      } catch (err: any) {
        attempt++;
        const status = err?.response?.status;
        const msg = err?.message || '-';
        console.warn(
          `[SERIES] page=${page} attempt=${attempt}/${maxRetries} status=${
            status ?? '-'
          } msg=${msg}`,
        );
        if (status === 429 && attempt <= maxRetries) {
          const backoff = baseDelay * Math.pow(2, attempt);
          console.warn(`[SERIES] 429 backoff ${backoff}ms`);
          await sleep(backoff);
          continue;
        }
        pageOk = true;
      }
    }

    if (counters.seriesStopOn3Dupes) {
      console.log('[SERIES] Stop after 3 consecutive duplicates');
      break;
    }
    if (!pageOk) break;

    page++;
    await throttle('series page');
  }

  // Enrichir & stocker les nouvelles séries
  for (const muId of newSeriesMuIds) {
    await upsertMuId(muId);
    await throttle('NEW upsert');
  }

  console.log('=== SUMMARY ===');
  console.log(
    JSON.stringify(
      {
        series: {
          pages: counters.seriesPages,
          itemsSeen: counters.seriesItemsSeen,
          newMuIds: counters.seriesNew,
          dupes: counters.seriesDupes,
          stopOn3Dupes: counters.seriesStopOn3Dupes,
          insertedNew: counters.insertedNew,
          updatedNew: counters.updatedNew,
        },
        retries429: counters.retries429,
      },
      null,
      2,
    ),
  );

  await appCtx.close();
  console.log('=== Periodic Update DONE ===');
}

bootstrap().catch((err) => {
  console.error('❌ Script periodicUpdate (series only) échoué :', err);
  process.exit(1);
});
