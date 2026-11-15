#!/usr/bin/env node
// scripts/n8n.mjs: push, pull and test workflows on the local n8n.
// No n8n API key needed: without N8N_API_KEY in .env it uses n8n's own CLI
// (import:workflow + publish:workflow), which a running n8n picks up in ~10-15 s.
// With N8N_API_KEY set it uses the public REST API instead (instant).
//
//   node scripts/n8n.mjs list                        workflows: id, name
//   node scripts/n8n.mjs push <file>                 import/update the workflow (by its "id"); publishes it if "active": true
//   node scripts/n8n.mjs pull <id> [file]            save the workflow from n8n into the repo (after a fix made in the UI)
//   node scripts/n8n.mjs activate <id>               publish so production webhooks answer
//   node scripts/n8n.mjs deactivate <id>
//   node scripts/n8n.mjs call <METHOD> <path> [json] hit a webhook with x-lo-key, e.g.
//        node scripts/n8n.mjs call POST lo/audit/run '{"user_id":"test-a"}'
//   node scripts/n8n.mjs api <METHOD> <path> [json]  raw public API call (needs N8N_API_KEY)

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const N8N_VERSION = JSON.parse(readFileSync(join(root, 'n8n/templates/node-versions.json'), 'utf8')).n8n;

function loadEnv() {
  const env = {};
  const file = join(root, '.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return { ...env, ...process.env };
}

const env = loadEnv();
const BASE = (env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/$/, '');
const useApi = Boolean(env.N8N_API_KEY);

// ---------- public REST API (when N8N_API_KEY is set) ----------
async function api(method, path, body) {
  if (!useApi) throw new Error('N8N_API_KEY is empty in .env (only needed for the `api` command)');
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'X-N8N-API-KEY': env.N8N_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  return json;
}

// ---------- n8n CLI (default, no key) ----------
const NOISE = /deprecat|N8N_[A-Z_]+ ->|^ - |^\s*$|Docker|license SDK|Python task runner/i;
function cli(...args) {
  const r = spawnSync('npx', ['-y', `n8n@${N8N_VERSION}`, ...args], {
    encoding: 'utf8', env: { ...process.env, N8N_DIAGNOSTICS_ENABLED: 'false' },
  });
  const out = `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => !NOISE.test(l)).join('\n').trim();
  if (r.status !== 0) {
    const hint = /database is locked|SQLITE_BUSY/i.test(out) ? '\n(another session is importing at the same moment: retry in a few seconds)' : '';
    throw new Error(`n8n ${args[0]} failed:\n${out}${hint}`);
  }
  return out;
}

const WRITABLE = ['name', 'nodes', 'connections', 'settings', 'staticData'];
const pick = (wf) => Object.fromEntries(WRITABLE.filter((k) => wf[k] !== undefined).map((k) => [k, wf[k]]));
const slug = (name) => name.toLowerCase().replace(/^lo-/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Repo copy of a workflow: stable keys only, so diffs show real changes.
function toRepoJson(wf, active) {
  const { id, name, nodes, connections, settings, staticData } = wf;
  return { id, name, active: active ?? Boolean(wf.active), nodes, connections, settings: settings ?? {}, staticData: staticData ?? null };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'list': {
      if (useApi) {
        const { data } = await api('GET', '/workflows?limit=250');
        for (const w of data.sort((a, b) => a.name.localeCompare(b.name))) console.log(`${w.id}|${w.name}${w.active ? '  (active)' : ''}`);
      } else {
        console.log(cli('list:workflow'));
      }
      break;
    }
    case 'push': {
      const [file] = args;
      const wf = JSON.parse(readFileSync(file, 'utf8'));
      if (!wf.id) throw new Error(`${file} has no "id": take it from n8n/ids.json`);
      if (useApi) {
        let exists = true;
        try { await api('GET', `/workflows/${wf.id}`); } catch { exists = false; }
        await (exists ? api('PUT', `/workflows/${wf.id}`, pick(wf)) : api('POST', '/workflows', { ...pick(wf) }));
        if (wf.active) await api('POST', `/workflows/${wf.id}/activate`);
      } else {
        cli('import:workflow', `--input=${file}`);
        if (wf.active) cli('publish:workflow', `--id=${wf.id}`);
      }
      console.log(`pushed ${wf.name} (${wf.id})${wf.active ? ', published' : ''}${useApi ? '' : ': live in ~10-15 s'}`);
      break;
    }
    case 'pull': {
      const [id, out] = args;
      let wf;
      if (useApi) {
        wf = await api('GET', `/workflows/${id}`);
      } else {
        const dir = mkdtempSync(join(tmpdir(), 'lo-pull-'));
        try {
          cli('export:workflow', `--id=${id}`, `--output=${join(dir, 'wf.json')}`);
          const parsed = JSON.parse(readFileSync(join(dir, 'wf.json'), 'utf8'));
          wf = Array.isArray(parsed) ? parsed[0] : parsed;
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }
      const file = out || join(root, 'n8n/workflows', `${slug(wf.name)}.json`);
      const prevActive = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).active : undefined;
      writeFileSync(file, `${JSON.stringify(toRepoJson(wf, prevActive ?? wf.active), null, 2)}\n`);
      console.log(`pulled ${wf.name} -> ${file}`);
      break;
    }
    case 'activate':
    case 'deactivate': {
      const [id] = args;
      if (useApi) await api('POST', `/workflows/${id}/${cmd}`);
      else cli(cmd === 'activate' ? 'publish:workflow' : 'unpublish:workflow', `--id=${id}`);
      console.log(`${cmd}d ${id}`);
      break;
    }
    case 'call': {
      const [method, path, body] = args;
      const res = await fetch(`${BASE}/webhook/${path.replace(/^\//, '')}`, {
        method,
        headers: { 'x-lo-key': env.N8N_WEBHOOK_KEY ?? '', 'content-type': 'application/json' },
        body: body && method !== 'GET' ? body : undefined,
      });
      const text = await res.text();
      let out; try { out = JSON.stringify(JSON.parse(text), null, 2); } catch { out = text; }
      console.log(`HTTP ${res.status}\n${out}`);
      if (!res.ok) process.exitCode = 1;
      break;
    }
    case 'api': {
      const [method, path, body] = args;
      console.log(JSON.stringify(await api(method, path, body ? JSON.parse(body) : undefined), null, 2));
      break;
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).join('\n'));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
