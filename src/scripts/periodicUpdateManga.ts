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

const RELEASES_SEARCH_URL = 'https://api.mangaupdates.com/v1/releases/search';

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
    `[HTTP] REQUEST ${label} -> ${url}\n${JSON.stringify(payload, null, 2)}`,
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

// Supprime tous les astérisques (markdown) et trim
function stripAsterisks(s: string): string {
  return (s ?? '').replace(/\*/g, '').trim();
}

// Titre série depuis "record" UNIQUEMENT, sans astérisques
type PeriodArg =
  | '1d'
  | '1w'
  | '1m'
  | `${number}d`
  | `${number}w`
  | `${number}m`;

function computePeriod(arg: PeriodArg): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const m = arg.match(/^(\d+)([dwm])$/i);
  const num = m ? parseInt(m[1], 10) : 1;
  const unit = (m ? m[2] : 'd').toLowerCase();
  const startDate = new Date(now);
  if (unit === 'd') startDate.setDate(now.getDate() - num);
  if (unit === 'w') startDate.setDate(now.getDate() - num * 7);
  if (unit === 'm') startDate.setMonth(now.getMonth() - num);
  const start = startDate.toISOString().slice(0, 10);
  return { start, end };
}

async function bootstrap() {
  const periodArg = (process.argv[2] as PeriodArg) || '1d';
  const { start, end } = computePeriod(periodArg);
  console.log(
    `=== Releases Title Update (record-only, with aliases) start=${start} end=${end} periodArg=${periodArg} ===`,
  );

  const appCtx = await NestFactory.createApplicationContext(AppModule);
  const service = appCtx.get(MangasService);
  const repo = appCtx.get<Repository<Manga>>(getRepositoryToken(Manga));

  const perPage = 100;
  const baseDelay = 1000; // ~1 req/s
  const jitter = 500;
  const maxRetries = 3;
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const counters = {
    pages: 0,
    itemsSeen: 0,
    titlesUnique: 0,
    dbHits: 0,
    dbMiss: 0,
    updatesOk: 0,
    titleMismatch: 0,
    retries429: 0,
    aliasHits: 0,
  };

  async function findByTitleOrAlias(
    titleSanitized: string,
  ): Promise<Manga | null> {
    // 1) Match direct sur title
    const direct = await repo.findOne({ where: { title: titleSanitized } });
    if (direct) {
      console.log(
        `[LOOKUP] direct title hit for "${titleSanitized}" (id=${direct.id})`,
      );
      return direct;
    }

    // Prépare l’aiguille pour les recherches JSON
    const needleArray = JSON.stringify([{ title: titleSanitized }]);

    // 2) Match via opérateur de contenance JSONB (@>) — fonctionne si la colonne est json/jsonb
    try {
      const byContainment = await repo
        .createQueryBuilder('m')
        .where('m.associated IS NOT NULL')
        .andWhere('(m.associated)::jsonb @> :needle::jsonb', {
          needle: needleArray,
        })
        .getOne();

      if (byContainment) {
        console.log(
          `[LOOKUP] alias hit via @> for "${titleSanitized}" (id=${byContainment.id})`,
        );
        return byContainment;
      }
    } catch (e: any) {
      console.warn('[LOOKUP] alias @> failed:', e?.message || e);
    }

    // 3) Match via jsonb_array_elements → elem->>'title' = :t (cast en jsonb pour supporter json)
    try {
      const byElem = await repo
        .createQueryBuilder('m')
        .where('m.associated IS NOT NULL')
        .andWhere(
          `EXISTS (
           SELECT 1
           FROM jsonb_array_elements((m.associated)::jsonb) elem
           WHERE elem->>'title' = :t
         )`,
          { t: titleSanitized },
        )
        .getOne();

      if (byElem) {
        console.log(
          `[LOOKUP] alias hit via jsonb_array_elements for "${titleSanitized}" (id=${byElem.id})`,
        );
        return byElem;
      }
    } catch (e: any) {
      console.warn(
        '[LOOKUP] alias jsonb_array_elements failed:',
        e?.message || e,
      );
    }

    // 4) Fallback ultime: LIKE sur le texte JSON (au cas où la colonne serait TEXT)
    try {
      const byLike = await repo
        .createQueryBuilder('m')
        .where('m.associated IS NOT NULL')
        .andWhere(`CAST(m.associated AS TEXT) ILIKE :needle`, {
          needle: `%\"title\":\"${titleSanitized.replace(/"/g, '\\"')}\"%`,
        })
        .getOne();

      if (byLike) {
        console.log(
          `[LOOKUP] alias hit via LIKE for "${titleSanitized}" (id=${byLike.id})`,
        );
        return byLike;
      }
    } catch (e: any) {
      console.warn('[LOOKUP] alias LIKE failed:', e?.message || e);
    }

    return null;
  }

  // Upsert par titre/alias exact : lookup DB -> muId -> get details -> save
  async function updateByReleaseTitle(
    releaseTitleSanitized: string,
    rel?: {
      release_id?: number | null;
      volume?: string | null;
      chapter?: string | null;
      release_date?: string | null;
      time_added?: string | null;
    },
  ) {
    const existing = await findByTitleOrAlias(releaseTitleSanitized);
    if (!existing) {
      counters.dbMiss++;
      console.log(
        `[UPDATE] no DB row for title/alias="${releaseTitleSanitized}", skip`,
      );
      return;
    }
    counters.dbHits++;
    const muId = Number(existing.mu_id);
    if (!muId) {
      console.warn(
        `[UPDATE] DB row title="${existing.title}" has no mu_id, skip`,
      );
      return;
    }

    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        console.log(
          `[UPSERT] muId=${muId} expected="${releaseTitleSanitized}" -> fetching details`,
        );
        const dto = await service.getMangaDetails(muId);

        // Vérifie exact match sur titre principal OU l'un des alias
        const dtoTitleSan = stripAsterisks(dto.title);
        const aliasMatch =
          Array.isArray(dto.associated) &&
          dto.associated.some(
            (a: any) =>
              stripAsterisks(String(a?.title ?? '')) === releaseTitleSanitized,
          );

        if (dtoTitleSan !== releaseTitleSanitized && !aliasMatch) {
          counters.titleMismatch++;
          console.warn(
            `[UPSERT] SKIP muId=${muId} title mismatch: got="${dto.title}" (or aliases) vs expected="${releaseTitleSanitized}"`,
          );
          return;
        }

        const entity = Manga.fromMU(dto);
        entity.id = existing.id; // update la même ligne
        await repo.save(entity);
        counters.updatesOk++;

        const ctx = rel
          ? ` | release_id=${rel.release_id ?? '-'} v=${rel.volume ?? '-'} c=${
              rel.chapter ?? '-'
            } date=${rel.release_date ?? rel.time_added ?? '-'}`
          : '';
        console.log(
          `✅ UPDATED id=${existing.id} muId=${muId} title="${dto.title}" totalCh=${dto.totalChapters} rating=${dto.rating}${ctx}`,
        );
        return;
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
        return;
      }
    }
  }

  // Boucle releases/search par pages — basé uniquement sur "record"
  const processedTitles = new Set<string>(); // dédup par titre (sanitisé)
  let page = 1;

  while (true) {
    counters.pages++;
    let pageOk = true;
    console.log(
      `[RELEASES] page=${page} window=${start}->${end} perpage=${perPage}`,
    );
    try {
      const payload = {
        start_date: start,
        end_date: end,
        perpage: perPage,
        page,
        exclude_genre: NSFW_GENRES,
      };
      const data = await postWithRetry(
        RELEASES_SEARCH_URL,
        payload,
        `releases page=${page}`,
      );
      const results: any[] = Array.isArray(data?.results) ? data.results : [];
      console.log(`[RELEASES] page=${page} results=${results.length}`);
      if (results.length === 0) break;

      // print each release (record-only)
      console.log(
        `[RELEASES] listing received releases (count=${results.length})`,
      );
      results.forEach((r, idx) => {
        const rec = r?.record ?? {};
        const rawTitle = rec.title ?? null;
        const sanitized = rawTitle ? stripAsterisks(String(rawTitle)) : '';
        const summary = {
          idx: idx + 1,
          release_id: rec.id ?? null,
          title_record_raw: rawTitle,
          title_record_sanitized: sanitized || null,
          volume: rec.volume ?? null,
          chapter: rec.chapter ?? null,
          release_date: rec.release_date ?? null,
          time_added:
            rec?.time_added?.as_rfc3339 ?? rec?.time_added?.as_string ?? null,
        };
        console.log(`[RELEASE] ${idx + 1}: ${JSON.stringify(summary)}`);
      });

      const titlesThisPage = new Set<string>();
      for (let i = 0; i < results.length; i++) {
        counters.itemsSeen++;
        const r = results[i];
        const rec = r?.record ?? {};
        const rawTitle = rec?.title ?? '';
        const title = stripAsterisks(String(rawTitle)); // sanitisé (sans *)

        console.log(
          `[RELEASE] #${i + 1} titleUsed="${title}" (raw="${rawTitle}")`,
        );

        if (!title) {
          console.warn('[RELEASES] skip item without series title');
          continue;
        }
        if (processedTitles.has(title) || titlesThisPage.has(title)) {
          console.log(`[RELEASES] skip duplicate title="${title}"`);
          continue;
        }

        const relCtx = {
          release_id: Number(rec.id ?? null),
          volume: rec.volume ?? null,
          chapter: rec.chapter ?? null,
          release_date: rec.release_date ?? null,
          time_added:
            rec?.time_added?.as_rfc3339 ?? rec?.time_added?.as_string ?? null,
        };

        counters.titlesUnique++;
        console.log(`[RELEASES] will update by title or alias="${title}"`);
        await updateByReleaseTitle(title, relCtx);

        titlesThisPage.add(title);
        processedTitles.add(title);

        const rawDelay = baseDelay + (Math.random() * 2 - 1) * jitter;
        await new Promise((res) =>
          setTimeout(res, Math.max(0, Math.round(rawDelay))),
        );
      }
    } catch (err: any) {
      pageOk = false;
      console.error(`[RELEASES] page=${page} error:`, err?.message || err);
    }

    if (!pageOk) break;
    page++;
    const rawDelay = baseDelay + (Math.random() * 2 - 1) * jitter;
    await new Promise((res) =>
      setTimeout(res, Math.max(0, Math.round(rawDelay))),
    );
  }

  console.log('=== SUMMARY ===');
  console.log(
    JSON.stringify(
      {
        period: { start, end, arg: periodArg },
        releases: {
          pages: counters.pages,
          itemsSeen: counters.itemsSeen,
          uniqueTitles: counters.titlesUnique,
          dbHits: counters.dbHits,
          dbMiss: counters.dbMiss,
          updatesOk: counters.updatesOk,
          titleMismatch: counters.titleMismatch,
          aliasHits: counters.aliasHits,
        },
        retries429: counters.retries429,
      },
      null,
      2,
    ),
  );

  await appCtx.close();
  console.log('=== Releases Title Update DONE ===');
}

bootstrap().catch((err) => {
  console.error(
    '❌ Script releases-title-update (record-only + aliases) échoué :',
    err,
  );
  process.exit(1);
});
