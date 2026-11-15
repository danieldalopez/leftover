#!/usr/bin/env node
// Writes a stub for every lane workflow that doesn't have a file yet (never
// overwrites a lane's work). Each stub owns its final name and routes (spec §19.1)
// and answers {"ok": true, "stub": true, "workflow": "LO-xx"}, so cross-lane calls
// work before the lane exists. Lanes replace the nodes but KEEP the "id".
//   node scripts/build-stubs.mjs   then push each new file with scripts/n8n.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nv = JSON.parse(readFileSync(join(root, 'n8n/templates/node-versions.json'), 'utf8')).nodes;
const ids = existsSync(join(root, 'n8n/ids.json')) ? JSON.parse(readFileSync(join(root, 'n8n/ids.json'), 'utf8')) : {};
const credId = ids.credentials?.lo_webhook_key ?? '__LO_WEBHOOK_KEY_ID__';

const STUBS = [
  { file: '01-onboarding-form', name: 'LO-01 Onboarding Form', routes: [], form: true },
  { file: '02-plaid-connect-sandbox', name: 'LO-02 Plaid Connect Sandbox', routes: [['POST', 'lo/plaid/connect-sandbox']] },
  { file: '03-transaction-sync', name: 'LO-03 Transaction Sync', routes: [['POST', 'lo/sync'], ['POST', 'lo/demo/add-txn']], subworkflow: true },
  { file: '03b-manual-expense', name: 'LO-03b Manual Expense', routes: [['POST', 'lo/expense']] },
  { file: '04-weekly-audit', name: 'LO-04 Weekly Audit', routes: [['POST', 'lo/audit/run']] },
  { file: '05-invest-executor', name: 'LO-05 Invest Executor', routes: [['POST', 'lo/invest/run']], subworkflow: true },
  { file: '06-order-reconcile', name: 'LO-06 Order Reconcile', routes: [['POST', 'lo/reconcile/run']] },
  { file: '07-weekly-digest', name: 'LO-07 Weekly Digest', routes: [['POST', 'lo/digest/send']], subworkflow: true },
  { file: '08-dashboard-api', name: 'LO-08 Dashboard API', routes: [['GET', 'lo/api/summary'], ['GET', 'lo/api/audits'], ['GET', 'lo/api/portfolio'], ['GET', 'lo/api/projection'], ['POST', 'lo/api/settings']] },
];

let wrote = 0;
for (const s of STUBS) {
  const file = join(root, 'n8n/workflows', `${s.file}.json`);
  if (existsSync(file)) { console.log(`skip ${s.file} (exists)`); continue; }
  const code = s.name.split(' ')[0];
  const nodes = [];
  const triggers = [];
  s.routes.forEach(([method, path], i) => {
    triggers.push({
      parameters: { httpMethod: method, path, authentication: 'headerAuth', responseMode: 'lastNode', responseData: 'firstEntryJson', options: {} },
      name: `${method} /${path}`, type: nv.webhook.type, typeVersion: nv.webhook.latest, position: [0, i * 180],
      webhookId: randomUUID(), credentials: { httpHeaderAuth: { id: credId, name: 'LO Webhook Key' } },
    });
  });
  if (s.subworkflow) {
    triggers.push({
      parameters: { inputSource: 'passthrough' }, name: 'Called by another workflow',
      type: nv.executeWorkflowTrigger.type, typeVersion: nv.executeWorkflowTrigger.latest, position: [0, s.routes.length * 180],
    });
  }
  if (s.form) {
    triggers.push({ parameters: {}, name: 'Run manually', type: nv.manualTrigger.type, typeVersion: nv.manualTrigger.latest, position: [0, 0] });
  }
  nodes.push(...triggers);
  nodes.push({
    parameters: { jsCode: `// STUB: replaced by its lane (see BUILD-PLAN.md). Keep the workflow id.\nreturn [{ json: { ok: true, stub: true, workflow: '${code}' } }];` },
    name: 'Stub response', type: nv.code.type, typeVersion: nv.code.latest, position: [320, 0],
  });
  nodes.push({
    parameters: { content: `## ${s.name}: stub\nOwned by its lane in BUILD-PLAN.md. Answers {ok:true, stub:true} until the lane replaces it.\nRoutes: ${s.routes.map((r) => r.join(' /')).join(', ') || 'n8n Form (own URL)'}` },
    name: 'About this stub', type: nv.stickyNote.type, typeVersion: nv.stickyNote.latest, position: [-40, -220],
  });
  const connections = Object.fromEntries(triggers.map((t) => [t.name, { main: [[{ node: 'Stub response', type: 'main', index: 0 }]] }]));
  const wf = { name: s.name, nodes, connections, settings: { executionOrder: 'v1', timezone: 'America/Vancouver' }, staticData: null };
  writeFileSync(file, `${JSON.stringify(wf, null, 2)}\n`);
  wrote++;
  console.log(`wrote ${s.file}.json`);
}
console.log(`${wrote} stub(s) written`);
