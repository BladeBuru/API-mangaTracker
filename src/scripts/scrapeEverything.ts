#!/usr/bin/env ts-node

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { MangasService } from '@/api/mangas/mangas.service';
import { promises as fs } from 'fs';

type AdvParams = Parameters<MangasService['searchMangaAdvanced']>[0];

type Task = {
  type?: string; // MU type (ex: "Manga")
  yearFrom: number; // borne inclusive
  yearTo: number; // borne inclusive
  prefix: string; // ex: "a", "a0", ...
  mode: 'letter' | 'search';
  nextPage: number; // page à appeler en prochain
};

const ALPHABET = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
const DEFAULT_NSFW_EXCLUDE = [
  'Adult',
  'Hentai',
  'Smut',
  'Lolicon',
  'Shotacon',
  'Doujinshi',
];

const BASE_DELAY = 1200;
const JITTER = 400;
const MAX_RETRIES = 3;
const BURST_PAUSE_EVERY = 20; // pause toutes les 20 pages
const BURST_PAUSE_MS = 3000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => BASE_DELAY + (Math.random() * 2 - 1) * JITTER;

// ---------- CLI ----------
// [2]=outPath (./muIds.json)
// [3]=perPage (100)
// [4]=maxPagesBucket (100)  ~ fenêtre ≈ 10k
// [5]=minYear (1950)
// [6]=maxYear (2025)
// [7]=yearSpan (0 = pas de split initial → une seule grande tranche)
// [8]=types CSV (ex: "Manga,Manhwa,Manhua,Novel")
// [9]=genres inclus CSV ("" pour aucun)
// [10]=genres exclus CSV ("" pour aucun → sinon remplace le défaut)
// [11]=todoPath (./scrape.todo.json)
const outPath = process.argv[2] || './muIds.json';
const PER_PAGE = Math.max(1, Number(process.argv[3] ?? 100));
const MAX_PAGES_BUCKET = Math.max(1, Number(process.argv[4] ?? 100));
const MIN_YEAR = Number(process.argv[5] ?? 1950);
const MAX_YEAR = Number(process.argv[6] ?? 2025);
const YEAR_SPAN = Number(process.argv[7] ?? 0);
const TYPES = process.argv[8]
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)?.length
  ? process.argv[8].split(',').map((s) => s.trim())
  : ['Manga', 'Manhwa', 'Manhua', 'Novel'];
const INCLUDED_GENRES =
  process.argv[9]
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? [];
const EXCLUDED_GENRES =
  process.argv[10]
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? DEFAULT_NSFW_EXCLUDE;
const TODO_PATH = process.argv[11] || './scrape.todo.json';

// -------------------------

function buildYearRanges(): Array<{ from: number; to: number }> {
  if (!YEAR_SPAN || YEAR_SPAN <= 0) return [{ from: MIN_YEAR, to: MAX_YEAR }];
  const out: Array<{ from: number; to: number }> = [];
  let y = MIN_YEAR;
  while (y <= MAX_YEAR) {
    const to = Math.min(y + YEAR_SPAN - 1, MAX_YEAR);
    out.push({ from: y, to });
    y = to + 1;
  }
  return out;
}

async function loadTodo(): Promise<Task[]> {
  try {
    const raw = await fs.readFile(TODO_PATH, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function saveTodo(todo: Task[]) {
  await fs.writeFile(TODO_PATH, JSON.stringify(todo, null, 2), 'utf8');
}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const service = app.get(MangasService);

  // Charger muIds existants (reprendre sans doublons)
  const seen = new Set<number>();
  const muIds: number[] = [];
  try {
    const existing = JSON.parse(await fs.readFile(outPath, 'utf8'));
    if (Array.isArray(existing)) {
      for (const id of existing)
        if (typeof id === 'number') {
          seen.add(id);
          muIds.push(id);
        }
      console.log(`📂 Chargé ${seen.size} muId(s) existants depuis ${outPath}`);
    }
  } catch {
    console.log(
      `ℹ️ Aucun fichier existant trouvé à ${outPath}, démarrage à vide`,
    );
  }
  const saveFile = async () =>
    fs.writeFile(outPath, JSON.stringify(muIds, null, 2), 'utf8');

  // Prépare / charge la TODO
  const todo: Task[] = await loadTodo();
  if (todo.length === 0) {
    const yearRanges = buildYearRanges();
    for (const t of TYPES) {
      for (const yr of yearRanges) {
        for (const c of ALPHABET) {
          todo.push({
            type: t,
            yearFrom: yr.from,
            yearTo: yr.to,
            prefix: c,
            mode: 'letter',
            nextPage: 1,
          });
        }
      }
    }
    await saveTodo(todo);
    console.log(`🔰 TODO initialisée (${todo.length} tâches).`);
  } else {
    console.log(
      `🔁 Reprise : ${todo.length} tâche(s) chargée(s) depuis ${TODO_PATH}`,
    );
  }

  async function fetchPageWithRetry(params: AdvParams, page: number) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const items = await service.searchMangaAdvanced(
          { ...params, page, perpage: PER_PAGE },
          { limit: PER_PAGE, page, mergeNsfwExclusion: false },
        );
        return items;
      } catch (err: any) {
        const code = err?.code;
        const status = err?.response?.status;
        const retryable =
          code === 'ECONNABORTED' ||
          code === 'ETIMEDOUT' ||
          code === 'ECONNRESET' ||
          status === 429;
        if (!retryable || attempt === MAX_RETRIES) throw err;
        const backoff = 800 * Math.pow(2, attempt);
        console.warn(
          `↻ retry #${attempt + 1} dans ${backoff}ms (reason=${
            code || status
          })`,
        );
        await sleep(backoff);
      }
    }
    return [];
  }

  function buildParamsFromTask(t: Task): AdvParams {
    const useLetter = t.mode === 'letter';
    const isSingleYear = t.yearFrom === t.yearTo;
    const p: AdvParams = {
      orderby: 'title',
      stype: 'title',
      ...(t.type ? { type: [t.type] } : {}),
      ...(isSingleYear ? { year: String(t.yearFrom) } : {}), // MU: une année unique seulement
      ...(INCLUDED_GENRES.length ? { genre: INCLUDED_GENRES } : {}),
      ...(EXCLUDED_GENRES.length ? { exclude_genre: EXCLUDED_GENRES } : {}),
      ...(useLetter ? { letter: t.prefix } : { search: t.prefix }),
    };
    if (!useLetter) delete (p as any).letter;
    return p;
  }

  function splitYears(t: Task): Task[] {
    const span = t.yearTo - t.yearFrom;
    if (span <= 0) return [t];
    const mid = Math.floor((t.yearFrom + t.yearTo) / 2);
    const left: Task = { ...t, yearFrom: t.yearFrom, yearTo: mid, nextPage: 1 };
    const right: Task = {
      ...t,
      yearFrom: mid + 1,
      yearTo: t.yearTo,
      nextPage: 1,
    };
    return [left, right];
  }

  /** Subdivise la tâche courante (années si possible, sinon préfixe) et remplace dans todo. */
  async function subdivideTask(idx: number, t: Task) {
    const span = t.yearTo - t.yearFrom;
    if (span >= 1) {
      // priorité: couper la plage d'années en deux
      const children = splitYears(t);
      todo.splice(idx, 1, ...children);
      await saveTodo(todo);
      return;
    }
    // déjà à l'année → subdiviser par préfixe
    const willStayLetter = t.mode === 'letter' && t.prefix.length + 1 <= 3;
    const nextMode: Task['mode'] = willStayLetter ? 'letter' : 'search';
    const children: Task[] = [];
    for (const c of ALPHABET) {
      children.push({
        type: t.type,
        yearFrom: t.yearFrom,
        yearTo: t.yearTo,
        prefix: t.prefix + c,
        mode: nextMode,
        nextPage: 1,
      });
    }
    todo.splice(idx, 1, ...children);
    await saveTodo(todo);
  }

  async function ingestTask(idx: number) {
    const t = todo[idx];
    const params = buildParamsFromTask(t);

    let page = t.nextPage;

    while (true) {
      // garde-fou avant appel: ne jamais dépasser la page 100
      if (page > MAX_PAGES_BUCKET) {
        console.warn(`⚠️ Fenêtre 10k atteinte (page ${page}) → subdivision`);
        await subdivideTask(idx, t);
        return;
      }

      const items = await fetchPageWithRetry(params, page);
      if (!items.length) {
        // Terminé pour ce bucket → retirer la tâche
        todo.splice(idx, 1);
        await saveTodo(todo);
        return;
      }

      let newCount = 0;
      for (const m of items) {
        const id = (m as any).muId ?? (m as any).mu_id ?? (m as any).id;
        if (id != null && !seen.has(id)) {
          seen.add(id);
          muIds.push(id);
          newCount++;
        }
      }
      if (newCount > 0) {
        console.log(
          `   ➕ ${newCount} nouveaux ID (page ${page}) — ${t.type ?? '—'} ${
            t.yearFrom
          }-${t.yearTo} ${t.mode}:${t.prefix}`,
        );
        await saveFile();
      }

      // checkpoint de page
      t.nextPage = page + 1;
      await saveTodo(todo);

      // burst pause périodique
      if (page % BURST_PAUSE_EVERY === 0) {
        console.log(`⏸ burst pause ${BURST_PAUSE_MS}ms (page ${page})`);
        await sleep(BURST_PAUSE_MS);
      }

      // Fenêtre atteinte juste après une page pleine → subdiviser
      if (page >= MAX_PAGES_BUCKET && items.length >= PER_PAGE) {
        console.warn(`⚠️ Seuil max atteint pour ce bucket → subdivision`);
        await subdivideTask(idx, t);
        return;
      }

      // Fin naturelle du bucket
      if (items.length < PER_PAGE) {
        todo.splice(idx, 1);
        await saveTodo(todo);
        return;
      }

      page++;
      await sleep(jitter());
    }
  }

  try {
    while (todo.length > 0) {
      // traite toujours la première (FIFO simple)
      await ingestTask(0);
    }
    console.log(
      `\n🎉 Terminé : ${seen.size} muId(s) uniques écrits dans ${outPath}`,
    );
  } catch (e: any) {
    console.error('❌ Échec:', e?.message || e);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

bootstrap().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
