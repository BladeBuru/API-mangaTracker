#!/usr/bin/env ts-node

/**
 * Scraper MU :
 * - Passe 1 : par année décroissante, sans filtre de type/genre
 * - Si un bucket annuel est trop gros / peu rentable → on subdivise en (genre, année) pour cette année
 * - Checkpoint (scrape.todo.json) pour reprise exacte
 * - Garde-fou 10k (page 100), retries/backoff, burst pause
 * - Déduplication des muIds et écriture incrémentale
 * - Logs des paramètres envoyés à chaque requête
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { MangasService } from '@/api/mangas/mangas.service';
import { promises as fs } from 'fs';

type AdvParams = Parameters<MangasService['searchMangaAdvanced']>[0];

type TaskKind = 'year' | 'genreYear';

type Task = {
  kind: TaskKind;
  year: number; // année unique (MU n’accepte pas de plage)
  genre?: string; // défini pour kind='genreYear'
  orderby?: string;
  nextPage: number;
};

const DEFAULT_NSFW_EXCLUDE = [
  'Adult',
  'Hentai',
  'Mature',
  'Smut',
  'Ecchi',
  'Lolicon',
  'Shotacon',
  'Doujinshi',
];

const GENRES_ALLOWED = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Fantasy',
  'Historical',
  'Horror',
  'Martial Arts',
  'Mystery',
  'Psychological',
  'Romance',
  'School Life',
  'Sci-fi',
  'Slice of Life',
  'Sports',
  'Supernatural',
  'Tragedy',
  'Mecha',
  'Harem',
  'Gender Bender',
];

const BASE_DELAY = 1200;
const JITTER = 400;
const MAX_RETRIES = 3;
const BURST_PAUSE_EVERY = 5;
const BURST_PAUSE_MS = 3000;
const MAX_EMPTY_PAGES = 5;
const MIN_NEW_RATIO = 0.05; // 5% de nouveaux mini
const ORDERBY_ALLOWED = new Set([
  'score',
  'title',
  'rating',
  'year',
  'date_added',
  'week_pos',
  'month1_pos',
  'month3_pos',
  'month6_pos',
  'year_pos',
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => BASE_DELAY + (Math.random() * 2 - 1) * JITTER;

// ---------------- CLI ----------------
// [2]=outPath (./muIds.json)
// [3]=perPage (100)
// [4]=maxPagesBucket (100)  ~ fenêtre ≈ 10k
// [5]=minYear (1950)
// [6]=maxYear (2025)
// [7]=(unused)
// [8]=genres inclus CSV (optionnel, sinon GENRES_ALLOWED)
// [9]=genres exclus CSV (optionnel, sinon NSFW défaut)
// [10]=todoPath (./scrape.todo.json)
// [11]=orderby (default "title")
const outPath = process.argv[2] || './muIds.json';
const PER_PAGE = Math.max(1, Number(process.argv[3] ?? 100));
const MAX_PAGES_BUCKET = Math.max(1, Number(process.argv[4] ?? 100));
const MIN_YEAR = Number(process.argv[5] ?? 1900);
const MAX_YEAR = Number(process.argv[6] ?? 2025);
// const _UNUSED = process.argv[7];
const INCLUDED_GENRES =
  process.argv[8]
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? GENRES_ALLOWED;
const EXCLUDED_GENRES =
  process.argv[9]
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? DEFAULT_NSFW_EXCLUDE;
const TODO_PATH = process.argv[10] || './scrape.todo.json';
const ORDERBY = (() => {
  const v = (process.argv[11] || 'title').trim();
  return ORDERBY_ALLOWED.has(v) ? v : 'title';
})();

// -------------- checkpoint --------------
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

// -------------- main --------------
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const service = app.get(MangasService);

  // muIds déjà connus
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

  // TODO initiale : années décroissantes, sans type/genre
  const todo: Task[] = await loadTodo();
  if (todo.length === 0) {
    for (let y = MAX_YEAR; y >= MIN_YEAR; y--) {
      todo.push({ kind: 'year', year: y, orderby: ORDERBY, nextPage: 1 });
    }
    await saveTodo(todo);
    console.log(`🔰 TODO initialisée (${todo.length} tâches annuelles).`);
  } else {
    console.log(
      `🔁 Reprise : ${todo.length} tâche(s) chargée(s) depuis ${TODO_PATH}`,
    );
  }

  // HTTP + retry/backoff
  async function fetchPageWithRetry(params: AdvParams, page: number) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(
          `📤 Params envoyés (page ${page}): ${JSON.stringify(params)}`,
        );
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

  // payload selon tâche
  function buildParamsFromTask(t: Task): AdvParams {
    const common: AdvParams = {
      orderby: t.orderby || ORDERBY,
      year: String(t.year),
      ...(EXCLUDED_GENRES.length ? { exclude_genre: EXCLUDED_GENRES } : {}),
    };
    if (t.kind === 'genreYear' && t.genre) {
      return { ...common, stype: 'title', genre: [t.genre] };
    }
    return { ...common, stype: 'title' };
  }

  // subdivision : d'une tâche annuelle vers toutes les (genre, année) pour cette année (ordre genres donné)
  async function subdivideYearToGenres(idx: number, t: Task, todoRef: Task[]) {
    const children: Task[] = [];
    for (const g of INCLUDED_GENRES) {
      children.push({
        kind: 'genreYear',
        year: t.year,
        genre: g,
        orderby: t.orderby || ORDERBY,
        nextPage: 1,
      });
    }
    todoRef.splice(idx, 1, ...children);
    await saveTodo(todoRef);
  }

  // traitement d'une tâche
  async function ingestTask(idx: number, todoRef: Task[]) {
    const t = todoRef[idx];
    const params = buildParamsFromTask(t);

    let page = t.nextPage;
    let emptyStreak = 0;
    let windowSeen = 0;
    let windowNew = 0;

    while (true) {
      // garde-fou MU : jamais > page 100
      if (page > MAX_PAGES_BUCKET) {
        console.warn(
          `⚠️ Fenêtre 10k atteinte (page ${page}) → subdivision genre/année si applicable`,
        );
        if (t.kind === 'year') await subdivideYearToGenres(idx, t, todoRef);
        else {
          todoRef.splice(idx, 1);
          await saveTodo(todoRef);
        }
        return;
      }

      const items = await fetchPageWithRetry(params, page);
      if (!items.length) {
        // fin naturelle
        todoRef.splice(idx, 1);
        await saveTodo(todoRef);
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
          `   ➕ ${newCount} nouveaux ID (page ${page}) — ${t.kind}` +
            `${t.kind === 'genreYear' ? `:${t.genre}` : ''} year=${t.year}`,
        );
        await saveFile();
      }

      // métriques utilité
      windowSeen += items.length;
      windowNew += newCount;
      emptyStreak = newCount === 0 ? emptyStreak + 1 : 0;

      // si peu utile → subdiviser (année → genres) ou stop si déjà genreYear
      if (emptyStreak >= MAX_EMPTY_PAGES) {
        console.log(
          `⛔ bucket peu utile : ${MAX_EMPTY_PAGES} pages sans nouveaux`,
        );
        if (t.kind === 'year') await subdivideYearToGenres(idx, t, todoRef);
        else {
          todoRef.splice(idx, 1);
          await saveTodo(todoRef);
        }
        return;
      }
      if (page % 3 === 0) {
        const ratio = windowSeen ? windowNew / windowSeen : 0;
        if (ratio < MIN_NEW_RATIO) {
          console.log(`⛔ faible ratio nouveaux=${(ratio * 100).toFixed(1)}%`);
          if (t.kind === 'year') await subdivideYearToGenres(idx, t, todoRef);
          else {
            todoRef.splice(idx, 1);
            await saveTodo(todoRef);
          }
          return;
        }
        windowSeen = 0;
        windowNew = 0;
      }

      // checkpoint
      t.nextPage = page + 1;
      await saveTodo(todoRef);

      // burst pause
      if (page % BURST_PAUSE_EVERY === 0) {
        console.log(`⏸ burst pause ${BURST_PAUSE_MS}ms (page ${page})`);
        await sleep(BURST_PAUSE_MS);
      }

      // exact 10k sur page 100 pleine
      if (page >= MAX_PAGES_BUCKET && items.length >= PER_PAGE) {
        console.warn(`⚠️ Seuil max atteint pour ce bucket`);
        if (t.kind === 'year') await subdivideYearToGenres(idx, t, todoRef);
        else {
          todoRef.splice(idx, 1);
          await saveTodo(todoRef);
        }
        return;
      }

      // fin naturelle
      if (items.length < PER_PAGE) {
        todoRef.splice(idx, 1);
        await saveTodo(todoRef);
        return;
      }

      page++;
      await sleep(jitter());
    }
  }

  try {
    while (todo.length > 0) {
      await ingestTask(0, todo);
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
