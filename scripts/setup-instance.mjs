#!/usr/bin/env node
// scripts/setup-instance.mjs: set up a self-hosted n8n from this repo in one go (n8n CLI, no API key).
//
//   node scripts/setup-instance.mjs                     credential + all 11 workflows, published in order
//   node scripts/setup-instance.mjs --skip-credentials  workflows only (the credential already exists)
//
// 1. Creates the `LO Webhook Key` credential (fixed id leftoverCredHook) from N8N_WEBHOOK_KEY in .env.
//    The key goes through a temp file that is deleted right after the import. `Plaid Sandbox` and
//    `Alpaca Paper` are created with placeholder values only if they don't exist yet.
// 2. Imports and publishes every workflow in IMPORT_ORDER. n8n 2.47 refuses to publish a workflow whose
//    Execute Workflow node points at an unpublished one, so callees come first:
//    LO-05 and LO-07 before LO-04, LO-04 before LO-00, LO-03 before LO-02.
// 3. Then run `node scripts/n8n.mjs call POST lo/demo/reset '{}'`: LO-00 creates every Data Table,
//    seeds config, category_map and Maya, and backfills her past weeks.
//
// Targets the instance in N8N_USER_FOLDER (default ~/.n8n). The instance may be running: a running
// n8n picks imports up in ~10-15 s. Third-party credentials (Alpaca, Plaid, Gmail) are entered
// by hand in n8n: see n8n/README.md.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { env, root } from './env.mjs';

const N8N_VERSION = JSON.parse(readFileSync(join(root, 'n8n/templates/node-versions.json'), 'utf8')).n8n;
const ids = JSON.parse(readFileSync(join(root, 'n8n/ids.json'), 'utf8'));

const IMPORT_ORDER = [
  '09-error-handler', '05-invest-executor', '07-weekly-digest', '04-weekly-audit', '00-setup-and-seed',
  '03-transaction-sync', '02-plaid-connect-sandbox', '03b-manual-expense', '01-onboarding-form',
  '06-order-reconcile', '08-dashboard-api',
];

function n8n(...args) {
  const r = spawnSync('npx', ['-y', `n8n@${N8N_VERSION}`, ...args], {
    encoding: 'utf8', env: { ...process.env, N8N_DIAGNOSTICS_ENABLED: 'false' },
  });
  if (r.status !== 0) throw new Error(`n8n ${args[0]} failed:\n${`${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-8).join('\n')}`);
}

function importWebhookCredential() {
  const key = env.N8N_WEBHOOK_KEY ?? '';
  if (!key) throw new Error('N8N_WEBHOOK_KEY is empty: set it in .env (any long random string)');
  const dir = mkdtempSync(join(tmpdir(), 'lo-cred-'));
  try {
    const file = join(dir, 'cred.json');
    writeFileSync(file, JSON.stringify([{
      id: ids.credentials.lo_webhook_key, name: 'LO Webhook Key', type: 'httpHeaderAuth',
      data: { name: 'x-lo-key', value: key },
    }]), { mode: 0o600 });
    n8n('import:credentials', `--input=${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`credential LO Webhook Key (${ids.credentials.lo_webhook_key}) imported`);
}

// Third-party credentials the workflows reference by fixed id. n8n won't publish a workflow whose
// credential doesn't exist, so a missing one is created with placeholder values (the flows then fall
// back as spec §19.5 says). An existing one is never touched, so real keys are never overwritten.
const PLACEHOLDERS = [
  { id: ids.credentials.plaid_sandbox, name: 'Plaid Sandbox', type: 'httpCustomAuth',
    data: { json: JSON.stringify({ body: { client_id: 'PASTE_PLAID_CLIENT_ID', secret: 'PASTE_PLAID_SANDBOX_SECRET' } }) } },
  { id: ids.credentials.alpaca_paper, name: 'Alpaca Paper', type: 'httpCustomAuth',
    data: { json: JSON.stringify({ headers: { 'APCA-API-KEY-ID': 'PASTE_ALPACA_PAPER_KEY_ID', 'APCA-API-SECRET-KEY': 'PASTE_ALPACA_PAPER_SECRET' } }) } },
];

function credentialExists(id) {
  const dir = mkdtempSync(join(tmpdir(), 'lo-cred-check-'));
  try {
    const file = join(dir, 'out.json');
    const r = spawnSync('npx', ['-y', `n8n@${N8N_VERSION}`, 'export:credentials', `--id=${id}`, `--output=${file}`], {
      encoding: 'utf8', env: { ...process.env, N8N_DIAGNOSTICS_ENABLED: 'false' },
    });
    if (r.status !== 0 || !existsSync(file)) return false;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.length > 0 : Boolean(parsed && parsed.id);
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ensurePlaceholderCredentials() {
  for (const c of PLACEHOLDERS) {
    if (credentialExists(c.id)) { console.log(`credential ${c.name} (${c.id}) exists: left as is`); continue; }
    const dir = mkdtempSync(join(tmpdir(), 'lo-cred-'));
    try {
      const file = join(dir, 'cred.json');
      writeFileSync(file, JSON.stringify([c]), { mode: 0o600 });
      n8n('import:credentials', `--input=${file}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    console.log(`credential ${c.name} (${c.id}) created with placeholder values: paste the real keys in n8n`);
  }
}

function pushAll() {
  for (const name of IMPORT_ORDER) {
    const file = join(root, 'n8n/workflows', `${name}.json`);
    const r = spawnSync('node', [join(root, 'scripts/n8n.mjs'), 'push', file], { encoding: 'utf8', env: process.env });
    const out = `${r.stdout}${r.stderr}`.trim();
    if (r.status !== 0) throw new Error(`push ${name} failed:\n${out}`);
    console.log(out.split('\n').pop());
  }
}

try {
  if (!process.argv.includes('--skip-credentials')) {
    importWebhookCredential();
    ensurePlaceholderCredentials();
  }
  pushAll();
  console.log('\nDone. Wait ~15 s, then: node scripts/n8n.mjs call POST lo/demo/reset \'{}\'');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
