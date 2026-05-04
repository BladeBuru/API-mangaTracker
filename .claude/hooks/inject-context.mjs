#!/usr/bin/env node
// PreToolUse hook : matche le file_path contre des globs et injecte la règle
// correspondante depuis .claude/rules/*.md via additionalContext.
// Reproduit la sémantique des règles glob-attached de Cursor.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES = join(HERE, '..', 'rules');

const PATTERNS = [
  { re: /\/.+\.controller\.ts$/i, file: 'nestjs-controller.md' },
  { re: /\/dto\/.+\.ts$|\/.+\.dto\.ts$|\/.+dto\.ts$/i, file: 'validation-dto.md' },
  { re: /\/main\.ts$/i, file: 'nest-main-security.md' },
  { re: /\/typeorm\.service\.ts$|\/data-source.*\.ts$/i, file: 'typeorm-config.md' },
  { re: /\/.+\.env(\..+)?$|\/template\.env$/i, file: 'env-secret-guard.md' },
];

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}
if (!raw) process.exit(0);

let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

// Normaliser : convertir les backslashes Windows et garantir un / initial
// pour que les regex `/...` matchent en relatif comme en absolu.
let fp = (input.tool_input?.file_path ?? '').replace(/\\/g, '/');
if (!fp) process.exit(0);
if (!fp.startsWith('/') && !/^[a-zA-Z]:\//.test(fp)) fp = '/' + fp;

const hits = PATTERNS.filter((p) => p.re.test(fp));
if (hits.length === 0) process.exit(0);

const sections = [];
for (const h of hits) {
  const path = join(RULES, h.file);
  if (existsSync(path)) {
    sections.push(`<!-- rule: ${h.file} -->\n${readFileSync(path, 'utf8')}`);
  }
}
if (sections.length === 0) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: sections.join('\n\n---\n\n'),
    },
  }),
);
