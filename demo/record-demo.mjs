#!/usr/bin/env node
// Records the demo video: drives the live onboarding form and dashboard in headless Chrome,
// with captions and spoken narration, and writes demo/leftover-demo.mp4 (under 3 minutes).
//
//   npm i --no-save playwright-core        (uses the installed Google Chrome; ffmpeg must be on PATH)
//   node demo/record-demo.mjs
//
// Needs n8n (5678) and the dashboard (DASHBOARD_URL, default http://localhost:3211) running live,
// and macOS `say` for the voice. It resets Maya before and after.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { env, root } from '../scripts/env.mjs';

const { chromium } = await import(env.PLAYWRIGHT_CORE ?? 'playwright-core');

const N8N = (env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/$/, '');
const DASH = (env.DASHBOARD_URL || 'http://localhost:3211').replace(/\/$/, '');
const KEY = env.N8N_WEBHOOK_KEY || '';
const OUT = join(root, 'demo', 'leftover-demo.mp4');
const WORK = env.FRAMES_DIR || join(root, 'demo', '.frames');
const FORM_EMAIL = 'test-d@leftover.test'; // an existing test user, so the run adds no new one
const VOICE = env.DEMO_VOICE || 'Samantha';
const MAX_SECONDS = 172; // the submission limit is 3 minutes

// What is on screen (caption) and what is said. "n 8 n" is how the voice reads n8n.
const LINES = {
  problem: ['', 'Young Canadians are saving, but not investing. Forty-one percent of Gen Z and Millennials with a T F S A are not investing the money in it. Round-up apps reward spending more. Nothing rewards spending less.'],
  solution: ['', 'Leftover invests what you did not spend. You set a weekly budget for each category. Every Sunday, an n 8 n workflow audits your week and invests the leftover.'],
  form1: ['Onboarding is an n8n form. First, a short financial profile.', 'Onboarding is an n 8 n form. First, a short financial profile.'],
  form2: ['Then weekly budgets, prefilled and editable.'],
  form3: ['Then a quiz that scores how much risk you can take, and how much you’re willing to take.'],
  form4: ['The result: a risk tier, a plain-language explanation, and a suggested ETF mix you can edit.', 'The result is a risk tier, a plain-language explanation, and a suggested E T F mix you can edit.'],
  consent: ['Nothing is invested without standing consent.'],
  saved: ['Everything is saved to n8n Data Tables.', 'Everything is saved to n 8 n Data Tables.'],
  week: ['This is Maya’s week, live from n8n. Groceries are under budget. Eating out is over.', 'This is Maya’s week, live from n 8 n. Groceries are under budget. Eating out is over.'],
  purchase: ['A new purchase comes in: $14 at a banh mi shop.', 'A new purchase comes in. Fourteen dollars at a banh mee shop.'],
  moved: ['The eating-out bar moves.'],
  audit: ['Now the Sunday audit, on demand: one workflow audits the week, a second splits the leftover across her ETF mix, a third writes the digest.', 'Now the Sunday audit, run on demand. One workflow audits the week. A second splits the leftover across her E T F mix. A third writes the digest.'],
  result: ['Each category’s unspent budget is added up. Half tops up her cash cushion; the rest is her investable leftover.', 'Each category’s unspent budget is added up. Half tops up her cash cushion. The rest is her investable leftover.'],
  history: ['History keeps every weekly audit, and a streak for each category.'],
  compounding: ['Compounding shows what each choice could grow into over 30 years. Illustrative, not a prediction.', 'Compounding shows what each choice could grow into over thirty years. Illustrative, not a prediction.'],
  digest: ['Every Sunday she gets a digest: her scoreboard, her cushion, and what this week’s leftover could become.'],
  settings: ['She stays in control: budgets, the cushion, and a pause switch.'],
  workflows: ['', 'Under the hood, n 8 n is the whole back end. Eleven workflows. A form for onboarding. A bank sync every six hours. The Sunday audit, which calls the invest and digest workflows. An hourly order reconcile, a dashboard A P I, and one error handler watching all of them.'],
  close: ['', 'We built Leftover with A I, from a written spec and frozen contracts. And we kept the money logic deterministic, covered by a hundred and ninety-five tests. Paper trading only. Not investment advice.'],
};

async function reset() {
  const res = await fetch(`${N8N}/webhook/lo/demo/reset`, {
    method: 'POST',
    headers: { 'x-lo-key': KEY, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`reset failed: HTTP ${res.status}`);
}

// ---------------------------------------------------------------- voice clips, made up front

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const clips = {};
for (const [id, [, spoken = LINES[id][0]]] of Object.entries(LINES)) {
  const file = join(WORK, `voice-${id}.aiff`);
  const made = spawnSync('say', ['-v', VOICE, '-r', '178', '-o', file, spoken]);
  if (made.status !== 0) throw new Error(`say failed for "${id}"`);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  clips[id] = { file, seconds: Number(probe.stdout) };
}

// ---------------------------------------------------------------- browser + frame capture

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: 'light' });
const page = await context.newPage();
page.on('dialog', (d) => d.accept());

// Caption bar and a visible cursor, added to every document.
await context.addInitScript(() => {
  const install = () => {
    if (document.getElementById('lo-rec-caption')) return;
    const cap = document.createElement('div');
    cap.id = 'lo-rec-caption';
    cap.style.cssText =
      'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);max-width:1000px;z-index:2147483646;' +
      'background:rgba(11,11,11,.9);color:#fff;font:500 19px/1.4 -apple-system,system-ui,sans-serif;' +
      'padding:12px 20px;border-radius:12px;text-align:center;display:none;pointer-events:none;box-shadow:0 6px 24px rgba(0,0,0,.25)';
    const cur = document.createElement('div');
    cur.id = 'lo-rec-cursor';
    cur.style.cssText =
      'position:fixed;left:-40px;top:-40px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;z-index:2147483647;' +
      'background:rgba(42,120,214,.35);border:2px solid #2a78d6;pointer-events:none;transition:transform .12s';
    document.documentElement.append(cap, cur);
    addEventListener('mousemove', (e) => { cur.style.left = `${e.clientX}px`; cur.style.top = `${e.clientY}px`; }, true);
    addEventListener('mousedown', () => { cur.style.transform = 'scale(.6)'; }, true);
    addEventListener('mouseup', () => { cur.style.transform = ''; }, true);
  };
  if (document.documentElement) install();
  addEventListener('DOMContentLoaded', install);
});

const cdp = await context.newCDPSession(page);
const frames = []; // { file, t }
let n = 0;
let recording = false;
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  if (!recording) return;
  const file = join(WORK, `f${String(n++).padStart(5, '0')}.jpg`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, t: metadata.timestamp });
});
// Safe to call again after a navigation: it throws only when the cast is already running.
const startCast = () => cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1 }).catch(() => {});

// ---------------------------------------------------------------- helpers

const wait = (ms) => page.waitForTimeout(Math.max(0, ms));
let mouse = { x: 640, y: 360 };
const cues = []; // { file, at } in epoch seconds, the clock the frames use
let voiceFreeAt = 0;

/** Shows a line's caption and starts its voice clip, after the previous clip has finished. Returns at once. */
async function narrate(id) {
  await wait(voiceFreeAt - Date.now());
  const text = LINES[id][0];
  await page.evaluate((t) => {
    const el = document.getElementById('lo-rec-caption');
    if (!el) return;
    el.textContent = t;
    el.style.display = t ? 'block' : 'none';
  }, text);
  cues.push({ file: clips[id].file, at: Date.now() / 1000 });
  voiceFreeAt = Date.now() + clips[id].seconds * 1000 + 350;
}
/** Narrates a line and waits until it has been said. */
async function say(id) {
  await narrate(id);
  await wait(voiceFreeAt - Date.now());
}
async function open(url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await startCast();
  await page.mouse.move(mouse.x, mouse.y);
}
async function moveTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  mouse = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(mouse.x, mouse.y, { steps: 12 });
  await wait(120);
}
async function click(locator) {
  await moveTo(locator);
  await page.mouse.down();
  await wait(80);
  await page.mouse.up();
  await wait(200);
}
async function scrollTo(y) {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'smooth' }), y);
  await wait(800);
}
async function card(title, lines) {
  recording = false; // not while the card's font loads
  await page.setContent(`<!doctype html><meta charset="utf-8">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Jersey+15&display=swap">
    <body style="margin:0;height:100vh;display:grid;place-items:center;background:#eceae3;color:#1b1b1b;font-family:'Jersey 15',monospace">
    <div style="max-width:900px;padding:0 40px">
      <div style="display:flex;align-items:center;gap:14px;font-size:40px">
        <span style="width:34px;height:34px;border:3px solid #1b1b1b;background:linear-gradient(#5b9b3b 0 38%,#7a553a 38%)"></span>Leftover</div>
      <h1 style="font-size:84px;line-height:1;font-weight:400;margin:28px 0 22px;text-shadow:5px 5px 0 #cfcdc4">${title}</h1>
      ${lines.map((l) => `<p style="font-size:32px;line-height:1.3;color:#5a5a54;margin:0 0 12px">${l}</p>`).join('')}
    </div></body>`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await startCast();
  recording = true;
  // a still page sends no frame: nudge it so the card is captured from its first moment
  await page.evaluate(() => { document.body.style.paddingTop = '1px'; });
  await wait(100);
}

/** Fills one page of the n8n form: one pick per choice group, text typed, prefilled numbers kept. */
async function fillFormPage(picks = {}, text = {}) {
  const fields = await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll('form input, form select')) {
      const key = (el.id.match(/field-\d+/) || [])[0];
      if (!key || seen.has(key) || el.type === 'hidden') continue;
      seen.add(key);
      out.push({ key, kind: el.tagName === 'SELECT' ? 'select' : el.id.startsWith('option') ? 'choice' : el.type });
    }
    return out;
  });
  for (const f of fields) {
    const i = picks[f.key];
    if (f.kind === 'select') {
      const sel = page.locator(`#${f.key}`);
      await moveTo(sel);
      await sel.selectOption({ index: (i ?? 1) + 1 });
    } else if (f.kind === 'choice') {
      await click(page.locator(`label[for="option${i ?? 0}_${f.key}"]`));
    } else if (f.kind === 'checkbox') {
      await click(page.locator(`label[for="${f.key}"]`).first());
    } else if (text[f.key] !== undefined) {
      const input = page.locator(`#${f.key}`);
      await click(input);
      await input.fill('');
      await input.pressSequentially(text[f.key], { delay: 22 });
    }
    await wait(60);
  }
}
async function submitFormPage() {
  await wait(voiceFreeAt - Date.now()); // let the line finish before the page changes
  await page.evaluate(() => { document.body.dataset.loRecOld = '1'; });
  await click(page.locator('#submit-btn'));
  // the next page is a new document
  await page.waitForFunction(() => document.body && !document.body.dataset.loRecOld, null, { timeout: 60_000 });
  await page.waitForLoadState('networkidle');
  await startCast();
  await wait(300);
}
const demoButton = (label) => page.locator('.demobar button', { hasText: label });
async function runDemoAction(label) {
  await click(demoButton(label));
  await page.waitForSelector('.demobar-result strong', { timeout: 120_000 });
  await page.waitForFunction(() => ![...document.querySelectorAll('.demobar button')].some((b) => b.textContent === 'Working…'), null, { timeout: 120_000 });
  await wait(600);
}
async function nav(label, heading = label) {
  await wait(voiceFreeAt - Date.now());
  await click(page.locator('.nav a', { hasText: label }));
  await page.waitForSelector(`h1:has-text("${heading}")`);
}

// ---------------------------------------------------------------- the run

await reset();

// Before its first real navigation Chrome casts a shorter viewport, so load a page first.
await page.goto(DASH, { waitUntil: 'networkidle' });

await card('Saving, but not investing', [
  '41% of Gen Z and Millennial Canadians with a TFSA aren’t investing the money in it (TD survey, Oct 2025).',
  'Round-up apps reward spending more. Nothing rewards spending less.',
]);
await say('problem');
await card('Leftover: invest what you didn’t spend', [
  'Set a weekly budget per category.',
  'Every Sunday, an n8n workflow audits your week and invests the leftover.',
]);
await say('solution');

// 1. Onboarding
await open(`${N8N}/form/lo-onboarding`);
await narrate('form1');
await fillFormPage(
  { 'field-2': 0, 'field-3': 0, 'field-4': 1, 'field-5': 1, 'field-6': 2, 'field-7': 1, 'field-8': 0 },
  { 'field-0': 'Dana', 'field-1': FORM_EMAIL },
);
await submitFormPage();
await narrate('form2');
await scrollTo(400);
await submitFormPage();
await narrate('form3');
await fillFormPage({ 'field-0': 3, 'field-1': 2, 'field-2': 2, 'field-3': 2, 'field-4': 1, 'field-5': 1, 'field-6': 0 });
await submitFormPage();
await say('form4');
await scrollTo(99999);
await narrate('consent');
const consent = page.locator('form input[type="checkbox"]').last();
if (!(await consent.isChecked())) await click(page.locator(`label[for="${await consent.getAttribute('id')}"]`).first());
await submitFormPage();
await say('saved');

// 2. This week
await open(DASH);
await narrate('week');
await moveTo(page.locator('.cat-list > div').nth(0));
await wait(1500);
await moveTo(page.locator('.cat-list > div').nth(1));
await say('purchase');
await runDemoAction('Add sandbox purchase');
await narrate('moved');
await moveTo(page.locator('.cat-list > div').nth(1));

// 3. The audit
await say('audit');
await runDemoAction('Run audit now');
await say('result');
await nav('History');
await narrate('history');
await scrollTo(760);
await nav('Compounding');
await narrate('compounding');
await scrollTo(360);

// 4. The digest
await nav('This week');
await narrate('digest');
await runDemoAction('Send digest');
await wait(voiceFreeAt - Date.now() + 600);

// 5. Settings
await nav('Settings');
await narrate('settings');
await scrollTo(300);
await wait(voiceFreeAt - Date.now());

await card('Under the hood: 11 n8n workflows', [
  'Onboarding form → Data Tables · bank sync every 6 hours',
  'Sunday audit → invest → digest · hourly order reconcile',
  'Dashboard API · one error handler for all of them',
]);
await say('workflows');
await card('Built with AI, on rules', [
  'Built with AI from a written spec and frozen contracts.',
  'The money logic is deterministic, with 195 tests. Paper trading only. Not investment advice.',
]);
await say('close');
await wait(600);
frames.push({ file: frames.at(-1).file, t: Date.now() / 1000 });

await cdp.send('Page.stopScreencast').catch(() => {});
await browser.close();
await reset();

// ---------------------------------------------------------------- frames + voice -> mp4

const t0 = frames[0].t;
const total = frames.at(-1).t - t0;
const speed = Math.max(1, total / MAX_SECONDS); // sped up just enough to stay under the limit

const list = frames
  .map((f, i) => `file '${f.file}'\nduration ${Math.max(0.02, (frames[i + 1]?.t ?? f.t + 0.04) - f.t).toFixed(3)}`)
  .join('\n');
writeFileSync(join(WORK, 'list.txt'), `${list}\nfile '${frames.at(-1).file}'\n`);

const voice = cues.map((c, i) => `[${i + 1}:a]adelay=${Math.max(0, Math.round((c.at - t0) * 1000))}:all=1[a${i}]`);
const filter = [
  `[0:v]setpts=PTS/${speed.toFixed(4)},fps=30,format=yuv420p[v]`,
  ...voice,
  `${cues.map((_, i) => `[a${i}]`).join('')}amix=inputs=${cues.length}:normalize=0,atempo=${speed.toFixed(4)}[a]`,
].join(';');
const ff = spawnSync(
  'ffmpeg',
  ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(WORK, 'list.txt'),
    ...cues.flatMap((c) => ['-i', c.file]),
    '-filter_complex', filter, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-c:a', 'aac', '-b:a', '128k',
    '-t', String(MAX_SECONDS + 4), '-movflags', '+faststart', OUT],
  { stdio: 'inherit' },
);
if (ff.status !== 0) process.exit(1);
if (!env.FRAMES_DIR) rmSync(WORK, { recursive: true, force: true });
console.log(`${OUT}: ${total.toFixed(0)} s recorded, played at ${speed.toFixed(2)}x, ${cues.length} voice clips`);
