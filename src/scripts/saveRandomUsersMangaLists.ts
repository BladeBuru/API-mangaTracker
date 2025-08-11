#!/usr/bin/env ts-node

//Usage : npx ts-node src/scripts/saveRandomUsersMangaLists.ts 100000 ./output.csv 30 30 20000
//# targetInteractions=100000, out=./output.csv, minUserRatings=30, minMangaRatings=30, maxUsers=20000

import * as path from 'path';
import * as fsSync from 'fs';
import { promises as fs } from 'fs';
import * as readline from 'readline';
import * as dotenv from 'dotenv';
import axios, { AxiosInstance } from 'axios';

dotenv.config({
  path: path.resolve(process.cwd(), 'src/common/envs/development.env'),
});

type JikanRandomUser = { data: { mal_id: number; username: string } };
type MalMangaListItem = {
  node: { id: number; title: string };
  list_status?: { score?: number };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (n: number) => new Intl.NumberFormat('en-US').format(n);
const fmtDuration = (sec: number) => {
  if (!isFinite(sec) || sec <= 0) return '—';
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = Math.floor(sec % 60);
  return [h ? `${h}h` : '', m ? `${m}m` : '', `${s}s`]
    .filter(Boolean)
    .join(' ');
};
const csvEscape = (s: string) => `"${String(s ?? '').replace(/"/g, '""')}"`;

function createMalClient(): AxiosInstance {
  const token = process.env.MAL_ACCESS_TOKEN;
  const clientId = process.env.MAL_CLIENT_ID;
  if (!token && !clientId)
    throw new Error('Set MAL_ACCESS_TOKEN or MAL_CLIENT_ID');
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  else headers['X-MAL-CLIENT-ID'] = clientId!;
  return axios.create({
    baseURL: 'https://api.myanimelist.net/v2',
    headers,
    timeout: 20000,
  });
}

const jikan = axios.create({
  baseURL: 'https://api.jikan.moe/v4',
  timeout: 20000,
});

async function getRandomUser(): Promise<{ malId: number; username: string }> {
  const { data } = await jikan.get<JikanRandomUser>('/random/users');
  return { malId: data.data.mal_id, username: data.data.username };
}

async function fetchAllMangaList(
  mal: AxiosInstance,
  username: string,
  perPage = 100,
): Promise<MalMangaListItem[]> {
  const items: MalMangaListItem[] = [];
  let offset = 0;
  const baseDelay = 600;
  const maxRetries = 3;
  while (true) {
    let attempt = 0;
    while (true) {
      try {
        const { data } = await mal.get(
          `/users/${encodeURIComponent(username)}/mangalist`,
          {
            params: { limit: perPage, offset, fields: 'list_status{score}' },
          },
        );
        const page: MalMangaListItem[] = data?.data ?? [];
        items.push(...page);
        if (page.length < perPage) return items;
        offset += perPage;
        await sleep(baseDelay);
        break;
      } catch (err: any) {
        const status = err?.response?.status;
        if (status && [403, 404].includes(status)) throw err;
        const is429 = status === 429 || String(err).includes('429');
        attempt++;
        if (is429 && attempt <= maxRetries) {
          await sleep(baseDelay * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }
  }
}

/** Reprend l’état depuis un CSV existant (même fichier que la sortie). */
async function resumeFromCsv(
  outCsv: string,
  minMangaRatings: number,
): Promise<{
  seenUsers: Set<number>;
  mangaCounts: Map<number, number>;
  eligible: number;
  totalRows: number;
}> {
  const seenUsers = new Set<number>();
  const mangaCounts = new Map<number, number>();
  let eligible = 0,
    totalRows = 0;

  if (!fsSync.existsSync(outCsv))
    return { seenUsers, mangaCounts, eligible, totalRows };

  const rl = readline.createInterface({
    input: fsSync.createReadStream(outCsv, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    if (!line.trim()) continue;

    // username,user_mal_id,manga_mal_id,score,title  (title quoted)
    const parts: string[] = [];
    let cur = '',
      inQ = false,
      commas = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQ = !inQ;
        cur += ch;
        continue;
      }
      if (ch === ',' && !inQ && commas < 4) {
        parts.push(cur);
        cur = '';
        commas++;
      } else cur += ch;
    }
    parts.push(cur);
    if (parts.length < 5) continue;

    const userMalId = Number(parts[1]);
    const mangaMalId = Number(parts[2]);
    if (!Number.isFinite(userMalId) || !Number.isFinite(mangaMalId)) continue;

    seenUsers.add(userMalId);
    const prior = mangaCounts.get(mangaMalId) ?? 0;
    const next = prior + 1;
    mangaCounts.set(mangaMalId, next);
    if (next === minMangaRatings) eligible += next;
    else if (next > minMangaRatings) eligible += 1;

    totalRows++;
  }
  return { seenUsers, mangaCounts, eligible, totalRows };
}

async function bootstrap() {
  // Args: [2]=targetInteractions, [3]=outCsv (ex: ./extract.csv), [4]=minUserRatings, [5]=minMangaRatings, [6]=maxUsersAttempts
  const targetInteractions = Math.max(1, Number(process.argv[2] ?? '100000'));
  const outCsv = process.argv[3] || './extract.csv';
  const minUserRatings = Math.max(1, Number(process.argv[4] ?? '30'));
  const minMangaRatings = Math.max(1, Number(process.argv[5] ?? '30'));
  const maxUsersAttempts = Math.max(1, Number(process.argv[6] ?? '999999'));

  // Reprise depuis le même fichier (continuation)
  const state = await resumeFromCsv(outCsv, minMangaRatings);
  const seenUsers = state.seenUsers;
  const mangaCounts = state.mangaCounts;
  let eligibleInteractions = state.eligible;
  let rowsWritten = state.totalRows;

  // Flux append ; header si nouveau fichier
  const fileExists = fsSync.existsSync(outCsv);
  const stream = fsSync.createWriteStream(outCsv, {
    flags: 'a',
    encoding: 'utf8',
  });
  if (!fileExists)
    stream.write('username,user_mal_id,manga_mal_id,score,title\n');

  const mal = createMalClient();
  const t0 = Date.now();

  console.log('—— Config ——');
  console.log(`targetInteractions: ${targetInteractions}`);
  console.log(`minUserRatings   : ${minUserRatings}`);
  console.log(`minMangaRatings  : ${minMangaRatings}`);
  console.log(`maxUsersAttempts : ${maxUsersAttempts}`);
  console.log(`out              : ${outCsv}`);
  console.log('—— Reprise ——');
  console.log(`users déjà vus   : ${fmt(seenUsers.size)}`);
  console.log(`lignes existantes: ${fmt(rowsWritten)}`);
  console.log(
    `éligibles exist. : ${fmt(eligibleInteractions)}/${fmt(
      targetInteractions,
    )}`,
  );
  console.log('———————');

  let attempts = 0;

  try {
    while (attempts < maxUsersAttempts) {
      attempts++;
      try {
        const { malId, username } = await getRandomUser();

        // déjà présent dans extract.csv → skip
        if (seenUsers.has(malId)) {
          await sleep(450);
          continue;
        }

        const list = await fetchAllMangaList(mal, username, 100);
        const scored = list
          .filter((it) => (it.list_status?.score ?? 0) > 0)
          .map((it) => ({
            username,
            userMalId: malId,
            mangaMalId: it.node.id,
            score: it.list_status!.score as number,
            title: it.node.title || '',
          }));

        if (scored.length >= minUserRatings) {
          seenUsers.add(malId);

          for (const r of scored) {
            const prior = mangaCounts.get(r.mangaMalId) ?? 0;
            const next = prior + 1;
            mangaCounts.set(r.mangaMalId, next);

            if (prior < minMangaRatings && next >= minMangaRatings) {
              eligibleInteractions += next;
            } else if (next > minMangaRatings) {
              eligibleInteractions += 1;
            }

            stream.write(
              `${r.username},${r.userMalId},${r.mangaMalId},${
                r.score
              },${csvEscape(r.title)}\n`,
              'utf8',
            );
            rowsWritten++;
          }

          const elapsedSec = (Date.now() - t0) / 1000;
          const done = eligibleInteractions;
          const remain = Math.max(0, targetInteractions - done);
          const rate = done > 0 ? done / elapsedSec : 0;
          const etaSec = rate > 0 ? remain / rate : Infinity;

          console.log(
            `✅ ${username}: +${scored.length} | éligibles=${fmt(done)}/${fmt(
              targetInteractions,
            )} | ETA ~ ${fmtDuration(etaSec)}`,
          );
        }

        if (eligibleInteractions >= targetInteractions) break; // après l'utilisateur courant
      } catch (err: any) {
        const status = err?.response?.status;
        if (!(status && [403, 404].includes(status))) {
          console.warn(`⚠️ ${status || ''} ${err?.message || err}`);
        }
      }
      await sleep(450); // pacing Jikan
    }
  } finally {
    stream.end();
  }

  const elapsed = (Date.now() - t0) / 1000;
  console.log('—— Résumé ——');
  console.log(`Temps écoulé        : ${fmtDuration(elapsed)}`);
  console.log(
    `Interactions éligibles: ${fmt(eligibleInteractions)}/${fmt(
      targetInteractions,
    )}`,
  );
  console.log(`Lignes CSV écrites  : ${fmt(rowsWritten)}`);
  console.log(`Utilisateurs vus    : ${fmt(seenUsers.size)}`);
  console.log(`Tentatives (users)  : ${fmt(attempts)}\n`);
}

bootstrap().catch((e) => {
  console.error('❌ Script failed:', e);
  process.exit(1);
});
