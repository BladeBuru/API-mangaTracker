#!/usr/bin/env node
// PreToolUse hook : repère les tentatives d'écriture de secrets (vraies valeurs
// dans un .env, JWT_KEY=..., GOOGLE_CLIENT_SECRET=...) et force la confirmation
// utilisateur via decision:"ask".

import { readFileSync } from 'node:fs';

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

const fp = (input.tool_input?.file_path ?? '').replace(/\\/g, '/');
const content = input.tool_input?.content ?? input.tool_input?.new_string ?? '';

const reasons = [];

// 1. Toute écriture vers un fichier .env (sauf template.env) est suspecte.
const isEnvFile = /\/.+\.env(\..+)?$/i.test(fp) && !/\/template\.env$/i.test(fp);
if (isEnvFile) {
  reasons.push(
    `Le fichier "${fp}" ressemble à un .env contenant potentiellement des secrets. Vérifier qu'il est bien gitignored et qu'aucune valeur sensible n'est commitée.`,
  );
}

// 2. Patterns de secrets dans le contenu écrit.
const SECRET_PATTERNS = [
  { name: 'JWT secret', re: /JWT_(KEY|SECRET|REFRESH_SECRET)\s*=\s*[^\s$].{8,}/i },
  { name: 'Google OAuth secret', re: /GOOGLE_CLIENT_SECRET\s*=\s*[^\s$].{8,}/i },
  { name: 'DB password', re: /DB_PASSWORD\s*=\s*[^\s$].{4,}/i },
  { name: 'Generic API key', re: /(api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}/i },
];
for (const p of SECRET_PATTERNS) {
  if (p.re.test(content)) {
    reasons.push(`Le contenu écrit contient ce qui ressemble à un ${p.name}.`);
  }
}

if (reasons.length === 0) process.exit(0);

const message = [
  'Garde-fou secrets — confirmation requise :',
  '',
  ...reasons.map((r) => `- ${r}`),
  '',
  'Règle CLAUDE.md : aucun secret en clair dans le repo, *.env doit être gitignored (sauf template.env).',
  'Confirmer si l\'écriture est volontaire et que le fichier ne sera pas committé tel quel.',
].join('\n');

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: message,
    },
  }),
);
