#!/usr/bin/env node
// Prints, for each dashboard data endpoint, whether it is live from n8n or mock (and why).
// Usage: node scripts/smoke.mjs [http://localhost:3000]   (the dashboard must be running)
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
let failed = 0;
for (const e of ['summary', 'audits', 'portfolio', 'projection', 'settings']) {
  try {
    const res = await fetch(`${base}/api/data/${e}`);
    const j = await res.json();
    const s = j.source ?? {};
    const tag = s.kind === 'live' ? 'LIVE' : `MOCK (${s.reason}: ${s.detail})`;
    console.log(`${e.padEnd(11)} ${res.status} ${tag}`);
    if (!res.ok || !j.data) failed++;
  } catch (err) {
    failed++;
    console.log(`${e.padEnd(11)} ERROR ${err.message}`);
  }
}
for (const p of ['/', '/history', '/portfolio', '/compounding', '/settings']) {
  const res = await fetch(`${base}${p}`);
  const html = await res.text();
  const ok = res.ok && html.includes('Not investment advice');
  if (!ok) failed++;
  console.log(`page ${p.padEnd(13)} ${res.status}${ok ? ' (disclaimer present)' : ' MISSING DISCLAIMER OR ERROR'}`);
}
process.exit(failed ? 1 : 0);
