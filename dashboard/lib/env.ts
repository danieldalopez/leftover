// Server-only configuration. Never import this from a client component.
//
// Order of precedence for each variable:
//   1. process.env (includes dashboard/.env.local, which Next loads; Vercel env vars)
//   2. the repo's .env: this checkout's root, then the main checkout's root when this is a
//      git worktree (same rule as scripts/n8n.mjs, because .env is gitignored and lane
//      worktrees don't have one).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface Env {
  mock: boolean;
  baseUrl: string;
  webhookKey: string;
  userId: string;
  keySource: string;
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {
    /* unreadable: ignore */
  }
  return out;
}

/** Candidate .env files outside dashboard/: repo root, then the main checkout of a worktree. */
function repoEnvFiles(): string[] {
  const files: string[] = [];
  // turbopackIgnore: a local-dev convenience; don't trace the filesystem into the server bundle.
  let dir = resolve(/*turbopackIgnore: true*/ process.cwd());
  for (let i = 0; i < 8; i++) {
    const git = join(/*turbopackIgnore: true*/ dir, '.git');
    if (existsSync(git)) {
      files.push(join(/*turbopackIgnore: true*/ dir, '.env'));
      try {
        if (statSync(git).isFile()) {
          // worktree: ".git" is a file "gitdir: /path/to/main/.git/worktrees/<name>"
          const m = readFileSync(git, 'utf8').match(/gitdir:\s*(.+)/);
          const idx = m ? m[1].trim().lastIndexOf('/.git/') : -1;
          if (m && idx > 0) files.push(join(/*turbopackIgnore: true*/ m[1].trim().slice(0, idx), '.env'));
        }
      } catch {
        /* ignore */
      }
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return files.filter((f) => existsSync(f));
}

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const fileVals: Record<string, string> = {};
  const fileFor: Record<string, string> = {};
  // later files must not override earlier ones
  for (const f of repoEnvFiles()) {
    for (const [k, v] of Object.entries(parseEnvFile(f))) {
      if (v !== '' && !(k in fileVals)) {
        fileVals[k] = v;
        fileFor[k] = f;
      }
    }
  }
  const pick = (k: string) => {
    const v = process.env[k];
    if (v !== undefined && v !== '') return { v, from: 'process env' };
    if (k in fileVals) return { v: fileVals[k], from: fileFor[k] };
    return { v: '', from: 'unset' };
  };
  const mock = /^(1|true|yes)$/i.test(pick('MOCK').v);
  const key = pick('N8N_WEBHOOK_KEY');
  cached = {
    mock,
    baseUrl: (pick('N8N_BASE_URL').v || 'http://localhost:5678').replace(/\/$/, ''),
    webhookKey: key.v,
    userId: pick('DEMO_USER_ID').v || 'maya',
    keySource: key.from,
  };
  return cached;
}
