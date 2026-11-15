#!/usr/bin/env node
// scripts/vercel-live.mjs: switch the Vercel dashboard (project `leftover`, linked in dashboard/.vercel)
// between live n8n data and its built-in sample data, then redeploy production.
//
//   node scripts/vercel-live.mjs https://<id>.app.lhr.life   live: MOCK=0, N8N_BASE_URL=<url>, N8N_WEBHOOK_KEY from .env
//   node scripts/vercel-live.mjs off                          sample data: MOCK=1
//
// Live mode first checks that <url>/webhook/lo/api/summary answers with the webhook key, so Vercel is
// never pointed at a dead URL. Values go to the Vercel CLI on stdin; the key is never printed.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { env, root } from './env.mjs';

const dash = join(root, 'dashboard');

function vercel(args, input) {
  const r = spawnSync('vercel', args, { cwd: dash, encoding: 'utf8', input });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}
function setEnv(name, value) {
  vercel(['env', 'rm', name, 'production', '--yes']); // fine if it didn't exist
  const r = vercel(['env', 'add', name, 'production'], value);
  if (!r.ok) throw new Error(`vercel env add ${name} failed:\n${r.out.split('\n').slice(-5).join('\n')}`);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) throw new Error('usage: node scripts/vercel-live.mjs <public n8n URL> | off');
  if (!existsSync(join(dash, '.vercel/project.json'))) throw new Error('dashboard/ is not linked to Vercel on this Mac (run `vercel link --project leftover` in dashboard/)');

  if (arg === 'off') {
    setEnv('MOCK', '1');
  } else {
    const base = arg.replace(/\/$/, '');
    if (!/^https:\/\//.test(base)) throw new Error(`not an https URL: ${base}`);
    const key = env.N8N_WEBHOOK_KEY ?? '';
    if (!key) throw new Error('N8N_WEBHOOK_KEY is empty in .env');
    const res = await fetch(`${base}/webhook/lo/api/summary?user_id=maya`, { headers: { 'x-lo-key': key } }).catch((e) => ({ ok: false, status: e.message }));
    if (!res.ok) throw new Error(`${base} doesn't answer the dashboard API (${res.status}); is the tunnel up and n8n running?`);
    setEnv('N8N_BASE_URL', base);
    setEnv('N8N_WEBHOOK_KEY', key);
    setEnv('DEMO_USER_ID', 'maya');
    setEnv('MOCK', '0');
  }
  const d = vercel(['deploy', '--prod', '--yes']);
  if (!d.ok) throw new Error(`vercel deploy failed:\n${d.out.split('\n').slice(-8).join('\n')}`);
  console.log(`Vercel production redeployed (${arg === 'off' ? 'sample data' : `live from ${arg}`}): https://leftover-rosy.vercel.app`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
