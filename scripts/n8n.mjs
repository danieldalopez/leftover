#!/usr/bin/env node
// scripts/n8n.mjs: talk to the local n8n through its public REST API.
// Reads N8N_BASE_URL, N8N_API_KEY and N8N_WEBHOOK_KEY from ../.env.
//
//   node scripts/n8n.mjs list                       workflows: id, active, name
//   node scripts/n8n.mjs pull <id> [file]           save a workflow as repo JSON (default: by name)
//   node scripts/n8n.mjs push <file>                update the workflow with the file's "id" (create if none)
//   node scripts/n8n.mjs activate <id>              publish/activate so production webhooks answer
//   node scripts/n8n.mjs deactivate <id>
//   node scripts/n8n.mjs call <METHOD> <path> [json] hit a webhook with x-lo-key, e.g.
//        node scripts/n8n.mjs call POST lo/audit/run '{"user_id":"test-a"}'
//   node scripts/n8n.mjs api <METHOD> <path> [json]  raw public API call, e.g. api GET /credentials

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

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

async function api(method, path, body) {
  if (!env.N8N_API_KEY) throw new Error('N8N_API_KEY is empty in .env (n8n > Settings > n8n API)');
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

// Fields the public API accepts on create/update. Everything else n8n adds itself.
const WRITABLE = ['name', 'nodes', 'connections', 'settings', 'staticData'];
const pick = (wf) => Object.fromEntries(WRITABLE.filter((k) => wf[k] !== undefined).map((k) => [k, wf[k]]));
const slug = (name) => name.toLowerCase().replace(/^lo-/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Repo copy of a workflow: stable keys only, so diffs show real changes.
function toRepoJson(wf) {
  const { id, name, nodes, connections, settings, staticData } = wf;
  return { id, name, nodes, connections, settings: settings ?? {}, staticData: staticData ?? null };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'list': {
      const { data } = await api('GET', '/workflows?limit=250');
      for (const w of data.sort((a, b) => a.name.localeCompare(b.name))) console.log(`${w.id}  ${w.active ? 'active  ' : 'inactive'}  ${w.name}`);
      break;
    }
    case 'pull': {
      const [id, out] = args;
      const wf = await api('GET', `/workflows/${id}`);
      const file = out || join(root, 'n8n/workflows', `${slug(wf.name)}.json`);
      writeFileSync(file, `${JSON.stringify(toRepoJson(wf), null, 2)}\n`);
      console.log(`pulled ${wf.name} -> ${file}`);
      break;
    }
    case 'push': {
      const [file] = args;
      const wf = JSON.parse(readFileSync(file, 'utf8'));
      const saved = wf.id ? await api('PUT', `/workflows/${wf.id}`, pick(wf)) : await api('POST', '/workflows', pick(wf));
      console.log(`${wf.id ? 'updated' : 'created'} ${saved.name} (${saved.id})`);
      if (!wf.id) {
        writeFileSync(file, `${JSON.stringify(toRepoJson(saved), null, 2)}\n`);
        console.log(`wrote id back into ${file}`);
      }
      break;
    }
    case 'activate':
    case 'deactivate': {
      const [id] = args;
      const r = await api('POST', `/workflows/${id}/${cmd}`);
      console.log(`${cmd}d ${r.name} (${r.id}) active=${r.active}`);
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
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n'));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
