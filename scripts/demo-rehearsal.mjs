#!/usr/bin/env node
// scripts/demo-rehearsal.mjs: runs the spec §15 demo against the live routes, step by step, exactly as
// the dashboard's demo bar calls them, and takes the documented fallback when a service is missing.
//
//   node scripts/demo-rehearsal.mjs           one run, then a reset so the real demo starts clean
//   node scripts/demo-rehearsal.mjs --twice   BUILD-PLAN Z step 6: two clean runs in a row
//
// Uses N8N_BASE_URL / N8N_WEBHOOK_KEY from .env (or the environment). Only touches maya.
// Exit code 1 if a step fails in a way the demo can't recover from.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function loadEnv() {
  let file = join(root, '.env');
  if (!existsSync(file)) {
    const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
    const main = r.status === 0 ? join(dirname(r.stdout.trim()), '.env') : '';
    if (main && existsSync(main)) file = main;
  }
  const env = {};
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
const USER = 'maya';

async function call(method, path, body) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/webhook/${path}`, {
    method, headers: { 'x-lo-key': env.N8N_WEBHOOK_KEY ?? '', 'content-type': 'application/json' },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { ok: false, error: { code: 'NOT_JSON', message: text.slice(0, 120) } }; }
  return { status: res.status, json, ms: Date.now() - t0 };
}
const eatingOut = (summary) => summary.json?.data?.lines?.find((l) => l.category_key === 'eating_out')?.actual_cad;
const err = (r) => (r.json?.error ? `${r.json.error.code}: ${r.json.error.message}` : `HTTP ${r.status}`);

async function rehearse(run) {
  let fatal = 0;
  const line = (mark, step, text) => console.log(`${mark} ${step.padEnd(28)} ${text}`);
  console.log(`\n=== Rehearsal ${run}  (${BASE})`);

  let r = await call('POST', 'lo/demo/reset', {});
  const bf = r.json?.data?.backfilled ?? [];
  if (r.json?.ok && bf.length === 3 && bf.every((b) => b.audit_id)) line('✓', 'Reset demo', `43 txns, 3 past weeks audited (${bf.map((b) => b.investable_cad).join(' / ')}), ${r.ms} ms`);
  else { line('✗', 'Reset demo', err(r)); fatal++; }

  r = await call('GET', `lo/api/summary?user_id=${USER}`);
  const before = eatingOut(r);
  if (r.json?.ok) line('✓', '"This week"', `eating out $${before} of $50 (over), groceries under`);
  else { line('✗', '"This week"', err(r)); fatal++; }

  r = await call('POST', 'lo/plaid/connect-sandbox', { user_id: USER });
  if (r.json?.ok) line('✓', 'Connect sandbox bank', `${r.json.data.institution_name}${r.json.data.already_linked ? ' (already linked)' : ''}`);
  else line('↷', 'Connect sandbox bank', `skipped: ${err(r)} (backup: seed + manual expense)`);

  r = await call('POST', 'lo/demo/add-txn', { user_id: USER, merchant: 'Banh Mi Saigon', amount_cad: 14 });
  if (r.json?.ok && (r.json.data?.sync?.added ?? 0) > 0) line('✓', 'Add sandbox purchase', `Banh Mi Saigon $14 via Plaid, synced`);
  else {
    line('↷', 'Add sandbox purchase', `Plaid: ${err(r)} → "Log it as a manual expense instead"`);
    r = await call('POST', 'lo/expense', { user_id: USER, amount_cad: 14, category_key: 'eating_out', merchant: 'Banh Mi Saigon' });
    if (r.json?.ok) line('✓', '  manual expense', `${r.json.data.txn_id} $14 eating_out`);
    else { line('✗', '  manual expense', err(r)); fatal++; }
  }

  r = await call('GET', `lo/api/summary?user_id=${USER}`);
  const after = eatingOut(r);
  if (r.json?.ok && Math.round((after - before) * 100) === 1400) line('✓', 'Bar moves', `eating out $${before} → $${after}`);
  else { line('✗', 'Bar moves', `eating out $${before} → $${after}`); fatal++; }

  r = await call('POST', 'lo/audit/run', { user_id: USER });
  const a = r.json?.data?.audits?.[0];
  if (r.json?.ok && a) {
    const inv = a.invest;
    const how = a.status === 'invested' ? `invested $${a.investable_cad} (${inv?.orders?.length ?? 0} orders)`
      : a.status === 'carried' ? `$${a.pending_carry_after_cad} carried to next week`
        : `computed: $${a.investable_cad} investable, not invested${inv?.error ? ` (${inv.error.code}: Alpaca not connected → "still shows the computed split")` : ''}`;
    line('✓', 'Run audit now', `left over $${a.gross_surplus_cad}, cushion $${a.buffer_after_cad}, ${how}, ${r.ms} ms`);
  } else { line('✗', 'Run audit now', err(r)); fatal++; }

  r = await call('GET', `lo/api/portfolio?user_id=${USER}`);
  if (r.json?.ok) {
    const q = r.json.data.orders?.filter((o) => o.status === 'queued').length ?? 0;
    line('✓', 'Portfolio', `${r.json.data.orders?.length ?? 0} orders (${q} queued), market_open ${r.json.data.market_open}`);
  } else { line('✗', 'Portfolio', err(r)); fatal++; }

  r = await call('POST', 'lo/digest/send', { user_id: USER });
  const d = r.json?.data;
  const fv = d?.body?.split(/(?<=[.!?])\s+/).find((s) => /30 years/.test(s));
  if (r.json?.ok) line('✓', 'Send digest', `sent to ${d.sent_to}: "${d.subject}"`);
  else if (r.status === 502 && d?.subject) line('↷', 'Send digest', `not sent (${err(r)}); email ready: "${d.subject}"`);
  else { line('✗', 'Send digest', err(r)); fatal++; }
  if (fv) line(' ', '  compounding line', fv.trim().slice(0, 110));

  r = await call('POST', 'lo/demo/reset', {});
  line(r.json?.ok ? '✓' : '✗', 'Reset for the real demo', r.json?.ok ? 'clean' : err(r));
  if (!r.json?.ok) fatal++;
  return fatal;
}

const runs = process.argv.includes('--twice') ? 2 : 1;
let failed = 0;
for (let i = 1; i <= runs; i++) failed += await rehearse(i);
console.log(failed ? `\n${failed} step(s) failed` : `\n${runs === 2 ? 'Both runs' : 'Run'} clean (↷ = documented fallback, spec §15 backup / §19.5)`);
process.exitCode = failed ? 1 : 0;
