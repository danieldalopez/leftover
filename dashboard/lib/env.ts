// Server-only configuration. Never import this from a client component.
//
// Each variable comes from process.env (dashboard/.env.local, or Vercel's env vars) and,
// when it's empty there, from the repo's root .env, so local dev needs no second copy of the key.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface Env {
  mock: boolean;
  baseUrl: string;
  webhookKey: string;
  userId: string;
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/** The repo root's .env (the nearest parent with a .git), or {} when there is none (Vercel). */
function repoEnv(): Record<string, string> {
  // turbopackIgnore: a local-dev convenience; don't trace the filesystem into the server bundle.
  let dir = resolve(/*turbopackIgnore: true*/ process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(/*turbopackIgnore: true*/ dir, '.git'))) {
      const file = join(/*turbopackIgnore: true*/ dir, '.env');
      return existsSync(file) ? parseEnvFile(file) : {};
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return {};
}

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const file = repoEnv();
  const pick = (k: string) => process.env[k] || file[k] || '';
  cached = {
    mock: /^(1|true|yes)$/i.test(pick('MOCK')),
    baseUrl: (pick('N8N_BASE_URL') || 'http://localhost:5678').replace(/\/$/, ''),
    webhookKey: pick('N8N_WEBHOOK_KEY'),
    userId: pick('DEMO_USER_ID') || 'maya',
  };
  return cached;
}
