#!/usr/bin/env ts-node

import axios, { AxiosError } from 'axios';
import { promises as fs } from 'fs';

type CategoryRecord = {
  category: string;
  usage: number;
  votes: number;
  votes_plus: number;
  votes_minus: number;
};

type ApiResult = { record: CategoryRecord };
type ApiResponse = {
  total_hits: number;
  page: number;
  per_page: number;
  results: ApiResult[];
};

const MU_CATEGORIES_URL = 'https://api.mangaupdates.com/v1/categories/search';
const outCsvPath = process.argv[2] || './categories.csv';
const PER_PAGE = Math.max(1, Number(process.argv[3] ?? 100));

const BASE_DELAY = 300;
const JITTER = 200;
const MAX_RETRIES = 3;

const ALPHABET = [...'abcdefghijklmnopqrstuvwxyz0123456789'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = () => BASE_DELAY + (Math.random() * 2 - 1) * JITTER;

function buildPayload(letter: string, page: number) {
  return {
    orderby: 'category',
    perpage: PER_PAGE,
    page,
    letter,
  };
}

async function fetchPage(letter: string, page: number): Promise<ApiResponse> {
  const payload = buildPayload(letter, page);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { data } = await axios.post<ApiResponse>(
        MU_CATEGORIES_URL,
        payload,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000,
        },
      );
      return data;
    } catch (e) {
      const err = e as AxiosError;
      const status = err.response?.status;
      const code = (err as any)?.code;
      const retryable =
        status === 429 ||
        status === 503 ||
        code === 'ECONNABORTED' ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNRESET';
      if (!retryable || attempt === MAX_RETRIES) throw err;
      const backoff = 600 * Math.pow(2, attempt);
      console.warn(
        `↻ retry #${attempt + 1} pour lettre "${letter}" après ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
  throw new Error('unreachable');
}

function toCsvLine(fields: (string | number)[]): string {
  return fields
    .map((v) => {
      const s = String(v ?? '');
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    })
    .join(',');
}

async function loadExistingCsv(): Promise<Set<string>> {
  const existing = new Set<string>();
  try {
    const raw = await fs.readFile(outCsvPath, 'utf8');
    const lines = raw.split(/\r?\n/).slice(1); // skip header
    for (const line of lines) {
      if (!line.trim()) continue;
      const category = line.split(',')[0].replace(/^"|"$/g, '').trim();
      if (category) existing.add(category);
    }
  } catch {
    // file may not exist — ignore
  }
  return existing;
}

async function main() {
  const existingCategories = await loadExistingCsv();
  let content = '';

  try {
    await fs.access(outCsvPath);
  } catch {
    content +=
      toCsvLine(['category', 'votes', 'usage', 'vote plus', 'vote minus']) +
      '\n';
  }

  for (const letter of ALPHABET) {
    let page = 1;
    let totalHits = Infinity;
    const newRows: CategoryRecord[] = [];

    console.log(`📡 Récupération catégories pour "${letter}"...`);

    while ((page - 1) * PER_PAGE < totalHits) {
      const data = await fetchPage(letter, page);
      if (page === 1) totalHits = data.total_hits ?? totalHits;

      const items = data.results ?? [];
      for (const it of items) {
        const r = it?.record;
        if (!r || !r.category) continue;
        if (!existingCategories.has(r.category)) {
          newRows.push({
            category: r.category,
            usage: Number(r.usage ?? 0),
            votes: Number(r.votes ?? 0),
            votes_plus: Number(r.votes_plus ?? 0),
            votes_minus: Number(r.votes_minus ?? 0),
          });
          existingCategories.add(r.category);
        }
      }

      if (items.length < PER_PAGE) break;
      page++;
      await sleep(jitter());
    }

    if (newRows.length > 0) {
      for (const r of newRows) {
        content +=
          toCsvLine([
            r.category,
            r.votes,
            r.usage,
            r.votes_plus,
            r.votes_minus,
          ]) + '\n';
      }
      console.log(
        `✅ ${newRows.length} nouvelles catégories ajoutées pour "${letter}"`,
      );
    } else {
      console.log(`ℹ️ Aucune nouvelle catégorie pour "${letter}"`);
    }

    await sleep(jitter());
  }

  if (content) {
    await fs.appendFile(outCsvPath, content, 'utf8');
    console.log(`💾 Fichier mis à jour : ${outCsvPath}`);
  } else {
    console.log(`Aucune mise à jour à écrire dans ${outCsvPath}`);
  }
}

main().catch((err) => {
  console.error('❌ categories export failed:', err?.message || err);
  process.exit(1);
});
