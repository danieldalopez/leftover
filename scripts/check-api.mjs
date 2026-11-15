#!/usr/bin/env node
// scripts/check-api.mjs: calls every live LO-08 endpoint and checks its response against
// contracts/fixtures/ (contracts/api.md: every key in a fixture is present, same JSON type;
// a value may be 0 or null but never missing). The dashboard's mock data is those fixtures,
// so this is the guarantee that the live API won't break the dashboard.
//
//   node scripts/check-api.mjs                 checks maya (read-only)
//   node scripts/check-api.mjs test-e          checks only the given user(s)
//   node scripts/check-api.mjs --no-write      skips the settings write round-trip on test-* users
//
// What it checks, per user:
//   summary, audits, portfolio, projection (rate 0.06 + 0.08), settings (no-op POST)
//   -> HTTP 200, ok: true, every fixture key present with the same type, money keys
//      (*_cad, *_usd) rounded to cents, a few enums (line state, order/audit status).
// Once: error envelopes (404 unknown user, 400 missing user_id, 400 bad rate, 400 bad settings).
// For test-* users only (never maya): a settings write round-trip, then restores the old values.
// Exit code 1 if anything fails. Needs n8n running and N8N_WEBHOOK_KEY in .env.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env, root } from './env.mjs';

const BASE = (env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/$/, '');
const KEY = env.N8N_WEBHOOK_KEY || '';

const fixture = (name) => JSON.parse(readFileSync(join(root, 'contracts/fixtures', `${name}.json`), 'utf8'));

// ---------- shape comparison ----------
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// Merge several example values into one template: objects -> union of keys, arrays -> one merged
// element, primitives -> first non-null example. Keys starting with "_" are fixture notes.
function template(values) {
  const vals = values.filter((v) => v !== undefined);
  const nonNull = vals.filter((v) => v !== null);
  if (!nonNull.length) return null;
  const k = kind(nonNull[0]);
  if (k === 'array') return [template(nonNull.flatMap((a) => a))].filter((x) => x !== null || nonNull.some((a) => a.length));
  if (k === 'object') {
    const out = {};
    const keys = [...new Set(nonNull.flatMap((o) => Object.keys(o)))].filter((x) => !x.startsWith('_'));
    for (const key of keys) out[key] = template(nonNull.map((o) => o[key]));
    return out;
  }
  return nonNull[0];
}

const ENUMS = {
  'lines[].state': ['ok', 'near', 'over'],
  'orders[].status': ['queued', 'partially_filled', 'filled', 'rejected', 'canceled'],
  'audits[].status': ['computed', 'invested', 'carried', 'skipped_paused'],
  status: ['active', 'paused'],
};
const isCents = (x) => Math.abs(x * 100 - Math.round(x * 100)) < 1e-6;

function compare(live, tpl, path, out) {
  if (live === undefined) return out.errors.push(`${path || '(root)'}: missing`);
  if (tpl === null || tpl === undefined) return undefined; // fixture says "may be null": any type
  if (live === null) {
    if (kind(tpl) === 'array') out.errors.push(`${path}: null, expected an array`);
    return undefined;
  }
  const lk = kind(live);
  const tk = kind(tpl);
  if (lk !== tk) return out.errors.push(`${path}: ${lk}, expected ${tk}`);
  const leaf = path.replace(/^data\./, '').replace(/\[\d+\]/g, '[]');
  if (tk === 'number' && /_(cad|usd)$/.test(path) && !isCents(live)) out.errors.push(`${path}: ${live} is not rounded to cents`);
  if (tk === 'string' && ENUMS[leaf] && !ENUMS[leaf].includes(live)) out.errors.push(`${path}: '${live}' not in ${ENUMS[leaf].join('|')}`);
  if (tk === 'array') {
    if (!tpl.length) return undefined;
    live.forEach((el, i) => compare(el, tpl[0], `${path}[${i}]`, out));
    return undefined;
  }
  if (tk === 'object') {
    for (const key of Object.keys(tpl)) compare(live[key], tpl[key], path ? `${path}.${key}` : key, out);
    for (const key of Object.keys(live)) if (!(key in tpl)) out.warnings.push(`${path ? `${path}.` : ''}${key}: not in fixture`);
  }
  return undefined;
}

// ---------- HTTP ----------
async function call(method, path, body) {
  const res = await fetch(`${BASE}/webhook/${path}`, {
    method,
    headers: { 'x-lo-key': KEY, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

let failures = 0;
const report = (label, out, note = '') => {
  if (out.errors.length) {
    failures += 1;
    console.log(`✗ ${label}${note ? `  ${note}` : ''}`);
    for (const e of out.errors.slice(0, 15)) console.log(`    - ${e}`);
    if (out.errors.length > 15) console.log(`    … ${out.errors.length - 15} more`);
  } else {
    console.log(`✓ ${label}${note ? `  ${note}` : ''}`);
  }
  for (const w of [...new Set(out.warnings)].slice(0, 5)) console.log(`    (warn) ${w}`);
};

// Success response vs fixture(s).
async function checkOk(label, method, path, body, fixtures, describe) {
  const out = { errors: [], warnings: [] };
  let res;
  try { res = await call(method, path, body); } catch (e) {
    out.errors.push(`request failed: ${e.message} (is n8n running at ${BASE}?)`);
    report(label, out);
    return null;
  }
  if (res.status !== 200) out.errors.push(`HTTP ${res.status}: ${JSON.stringify(res.json).slice(0, 200)}`);
  else if (!res.json || res.json.ok !== true) out.errors.push(`ok is not true: ${JSON.stringify(res.json).slice(0, 200)}`);
  else compare(res.json, template(fixtures.map(fixture)), '', out);
  report(label, out, out.errors.length || !describe ? '' : describe(res.json.data));
  return out.errors.length ? null : res.json.data;
}

// Error response vs error.json.
async function checkError(label, method, path, body, status, code) {
  const out = { errors: [], warnings: [] };
  const res = await call(method, path, body);
  if (res.status !== status) out.errors.push(`HTTP ${res.status}, expected ${status}`);
  compare(res.json, template([fixture('error')]), '', out);
  if (res.json && res.json.ok !== false) out.errors.push('ok is not false');
  if (res.json && res.json.error && res.json.error.code !== code) out.errors.push(`error.code ${res.json.error.code}, expected ${code}`);
  report(label, out, res.json && res.json.error ? `${res.status} ${res.json.error.code}` : '');
}

async function settingsRoundTrip(user, before) {
  const label = `${user} settings write round-trip`;
  const out = { errors: [], warnings: [] };
  const b0 = before.budgets[0];
  if (!b0) {
    out.errors.push('user has no budgets');
    return report(label, out);
  }
  const changed = await call('POST', 'lo/api/settings', {
    user_id: user,
    cushion_rate: before.cushion_rate === 0.5 ? 0.4 : 0.5,
    budgets: [{ category_key: b0.category_key, weekly_amount: Math.round((b0.weekly_amount_cad + 1.25) * 100) / 100 }],
  });
  const d = changed.json && changed.json.data;
  if (changed.status !== 200 || !d) out.errors.push(`update: HTTP ${changed.status} ${JSON.stringify(changed.json).slice(0, 200)}`);
  else {
    if (d.cushion_rate === before.cushion_rate) out.errors.push('cushion_rate did not change');
    const nb = d.budgets.find((x) => x.category_key === b0.category_key);
    if (!nb || Math.abs(nb.weekly_amount_cad - (b0.weekly_amount_cad + 1.25)) > 0.001) out.errors.push(`budget ${b0.category_key} did not change`);
    if (d.budgets.length !== before.budgets.length) out.errors.push('budget count changed');
  }
  const restored = await call('POST', 'lo/api/settings', {
    user_id: user,
    cushion_rate: before.cushion_rate,
    budgets: [{ category_key: b0.category_key, weekly_amount: b0.weekly_amount_cad }],
  });
  const r = restored.json && restored.json.data;
  if (!r || JSON.stringify(r) !== JSON.stringify(before)) out.errors.push('restore did not bring back the original settings');
  report(label, out, out.errors.length ? '' : `changed + restored ${b0.category_key} and cushion_rate`);
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const write = !args.includes('--no-write');
  const users = args.filter((a) => !a.startsWith('--'));
  if (!users.length) users.push('maya');
  if (!KEY) console.log('(warn) N8N_WEBHOOK_KEY is empty: expect 403s');
  console.log(`LO-08 at ${BASE}/webhook/  users: ${users.join(', ')}\n`);

  for (const u of users) {
    const q = encodeURIComponent(u);
    await checkOk(`${u} GET /lo/api/summary`, 'GET', `lo/api/summary?user_id=${q}`, undefined, ['summary'],
      (d) => `${d.lines.length} lines, week ${d.week.week_start}, ${d.lifetime.weeks_audited} audits, last ${d.last_audit ? d.last_audit.status : 'none'}`);
    await checkOk(`${u} GET /lo/api/audits`, 'GET', `lo/api/audits?user_id=${q}`, undefined, ['audits'],
      (d) => `${d.audits.length} audits, ${d.streaks.length} streaks, invested ${d.totals.invested_cad}`);
    await checkOk(`${u} GET /lo/api/portfolio`, 'GET', `lo/api/portfolio?user_id=${q}`, undefined, ['portfolio', 'portfolio-queued'],
      (d) => `${d.positions.length} positions, ${d.orders.length} orders, queued $${d.totals.queued_usd}, fx ${d.fx_rate_usdcad} (${d.fx_source}), market_open ${d.market_open}`);
    await checkOk(`${u} GET /lo/api/projection`, 'GET', `lo/api/projection?user_id=${q}&rate=0.06`, undefined, ['projection'],
      (d) => `contributed ${d.lifetime.contributed_cad}, ${d.your_choices.length} choices, last_week ${d.last_week ? d.last_week.audit_id : 'null'}`);
    await checkOk(`${u} GET /lo/api/projection (rate 0.08)`, 'GET', `lo/api/projection?user_id=${q}&rate=0.08`, undefined, ['projection'],
      (d) => `selected_rate ${d.selected_rate}`);
    const settings = await checkOk(`${u} POST /lo/api/settings (no-op)`, 'POST', 'lo/api/settings', { user_id: u }, ['settings'],
      (d) => `${d.budgets.length} budgets, status ${d.status}`);
    if (write && settings && /^test-/.test(u)) await settingsRoundTrip(u, settings);
  }

  console.log('');
  await checkError('unknown user -> 404', 'GET', 'lo/api/summary?user_id=nobody-here', undefined, 404, 'NOT_FOUND');
  await checkError('missing user_id -> 400', 'GET', 'lo/api/audits', undefined, 400, 'BAD_REQUEST');
  await checkError('unknown user (portfolio) -> 404', 'GET', 'lo/api/portfolio?user_id=nobody-here', undefined, 404, 'NOT_FOUND');
  await checkError('bad rate -> 400', 'GET', `lo/api/projection?user_id=${encodeURIComponent(users[0])}&rate=0.5`, undefined, 400, 'BAD_REQUEST');
  await checkError('bad cushion_rate -> 400', 'POST', 'lo/api/settings', { user_id: users[0], cushion_rate: 2 }, 400, 'BAD_REQUEST');
  await checkError('unknown budget -> 400', 'POST', 'lo/api/settings', { user_id: users[0], budgets: [{ category_key: 'yachts', weekly_amount: 1 }] }, 400, 'BAD_REQUEST');

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
