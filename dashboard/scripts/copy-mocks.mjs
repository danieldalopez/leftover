#!/usr/bin/env node
// Copies ../contracts/fixtures/*.json into dashboard/mocks/ (Vercel only sees dashboard/).
// Run after any contract change: `npm run mocks`. Commit the result.
// Safe to run where ../contracts doesn't exist (e.g. a Vercel build): it keeps the committed mocks.
import { readdirSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'contracts', 'fixtures');
const dest = join(here, '..', 'mocks');

if (!existsSync(src)) {
  console.log(`copy-mocks: ${src} not found, keeping the committed mocks/`);
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
let changed = 0;
const files = readdirSync(src).filter((f) => f.endsWith('.json'));
for (const f of files) {
  const from = join(src, f);
  const to = join(dest, f);
  const same = existsSync(to) && readFileSync(to, 'utf8') === readFileSync(from, 'utf8');
  if (!same) { copyFileSync(from, to); changed++; }
}
console.log(`copy-mocks: ${files.length} fixtures, ${changed} updated -> mocks/`);
