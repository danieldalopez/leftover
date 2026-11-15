#!/usr/bin/env node
// scripts/update-icu-tz.mjs: refresh n8n/icu-tz/*.res (ICU timezone data) from the newest Homebrew ICU
// installed on this Mac. No download: it reads the ICU data library Homebrew already has.
//
//   brew upgrade icu4c            (optional: gets the newest tz release)
//   node scripts/update-icu-tz.mjs
//   npm test && git add n8n/icu-tz
//
// How: libicudata.dylib embeds ICU's common data package ("CmnD"). This finds it, writes it out as a
// .dat, and lets icupkg extract the four timezone resources. See n8n/icu-tz/README.md for why.

import { readFileSync, writeFileSync, realpathSync, mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'n8n/icu-tz');
const ICU = process.env.ICU_PREFIX || '/opt/homebrew/opt/icu4c';
const FILES = ['zoneinfo64.res', 'metaZones.res', 'timezoneTypes.res', 'windowsZones.res'];

const lib = realpathSync(join(ICU, 'lib/libicudata.dylib'));
const icupkg = join(ICU, 'sbin/icupkg');
if (!existsSync(icupkg)) throw new Error(`${icupkg} not found (brew install icu4c)`);

const buf = readFileSync(lib);
// MappedData {uint16 headerSize, 0xda, 0x27} then UDataInfo whose dataFormat "CmnD" is 12 bytes in.
let at = -1;
for (let i = buf.indexOf('CmnD'); i !== -1; i = buf.indexOf('CmnD', i + 1)) {
  if (buf[i - 10] === 0xda && buf[i - 9] === 0x27) { at = i - 12; break; }
}
if (at < 0) throw new Error(`no ICU common data found in ${lib}`);

const dir = mkdtempSync(join(tmpdir(), 'lo-icu-'));
try {
  // icupkg wants the file named after the package inside it: icudt<major>l.dat
  const major = (lib.match(/libicudata\.(\d+)/) || [])[1];
  if (!major) throw new Error(`can't read the ICU version from ${lib}`);
  const dat = join(dir, `icudt${major}l.dat`);
  writeFileSync(dat, buf.subarray(at));
  for (const f of FILES) {
    const r = spawnSync(icupkg, ['-x', f, '-d', dir, dat], { encoding: 'utf8' });
    if (r.status !== 0 || !existsSync(join(dir, f))) throw new Error(`icupkg could not extract ${f}: ${r.stderr}`);
    copyFileSync(join(dir, f), join(OUT, f));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const check = spawnSync('node', ['-e', 'console.log(process.versions.tz)'], {
  encoding: 'utf8', env: { ...process.env, ICU_TIMEZONE_FILES_DIR: OUT },
});
console.log(`n8n/icu-tz updated from ${lib}: tz ${check.stdout.trim()}`);
