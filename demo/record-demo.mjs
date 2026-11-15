#!/usr/bin/env node
// Records the backup video (spec §15): drives the live onboarding form and dashboard in headless
// Chrome, following demo/demo-script.md, and writes demo/leftover-demo.mp4 with captions.
//
//   npm i --no-save playwright-core        (uses the installed Google Chrome; ffmpeg must be on PATH)
//   node demo/record-demo.mjs
//
// Needs n8n (5678) and the dashboard (DASHBOARD_URL, default http://localhost:3211) running live.
// It resets Maya before and after. The n8n canvas isn't in the video: it needs the owner login.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { env, root } from '../scripts/env.mjs';

const { chromium } = await import(env.PLAYWRIGHT_CORE ?? 'playwright-core');

const N8N = (env.N8N_BASE_URL || 'http://localhost:5678').replace(/\/$/, '');
const DASH = (env.DASHBOARD_URL || 'http://localhost:3211').replace(/\/$/, '');
const KEY = env.N8N_WEBHOOK_KEY || '';
const OUT = join(root, 'demo', 'leftover-demo.mp4');
const FRAMES = env.FRAMES_DIR || join(root, 'demo', '.frames');
const FORM_EMAIL = 'test-d@leftover.test'; // an existing test user, so the run adds no new one

async function reset() {
  const res = await fetch(`${N8N}/webhook/lo/demo/reset`, {
    method: 'POST',
    headers: { 'x-lo-key': KEY, 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`reset failed: HTTP ${res.status}`);
}

// ---------------------------------------------------------------- browser + frame capture

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

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
  const file = join(FRAMES, `f${String(n++).padStart(5, '0')}.jpg`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, t: metadata.timestamp });
});
// Safe to call again after a navigation: it throws only when the cast is already running.
const startCast = () =>
  cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1 }).catch(() => {});

// ---------------------------------------------------------------- helpers

const wait = (ms) => page.waitForTimeout(ms);
let mouse = { x: 640, y: 360 };

async function caption(text) {
  await page.evaluate((t) => {
    const el = document.getElementById('lo-rec-caption');
    if (!el) return;
    el.textContent = t;
    el.style.display = t ? 'block' : 'none';
  }, text);
}
/** Show a caption long enough to read it. */
async function say(text, ms = 1200 + text.length * 45) {
  await caption(text);
  await wait(ms);
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
  await page.mouse.move(mouse.x, mouse.y, { steps: 24 });
  await wait(250);
}
async function click(locator) {
  await moveTo(locator);
  await page.mouse.down();
  await wait(90);
  await page.mouse.up();
  await wait(350);
}
async function scrollTo(y) {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'smooth' }), y);
  await wait(900);
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
      await input.pressSequentially(text[f.key], { delay: 35 });
    }
    await wait(120);
  }
}
async function submitFormPage() {
  await page.evaluate(() => { document.body.dataset.loRecOld = '1'; });
  await click(page.locator('#submit-btn'));
  // the next page is a new document
  await page.waitForFunction(() => document.body && !document.body.dataset.loRecOld, null, { timeout: 60_000 });
  await page.waitForLoadState('networkidle');
  await startCast();
  await wait(600);
}
const demoButton = (label) => page.locator('.demobar button', { hasText: label });
async function runDemoAction(label, done = '.demobar-result strong') {
  await click(demoButton(label));
  await page.waitForSelector(done, { timeout: 120_000 });
  await page.waitForFunction(() => ![...document.querySelectorAll('.demobar button')].some((b) => b.textContent === 'Working…'), null, { timeout: 120_000 });
  await wait(800);
}
const nav = (label) => click(page.locator('.nav a', { hasText: label }));

// ---------------------------------------------------------------- the run (demo/demo-script.md)

await reset();

// Before its first real navigation Chrome casts a shorter viewport, so load a page first.
await page.goto(DASH, { waitUntil: 'networkidle' });

await card('Saving, but not investing', [
  '41% of Gen Z and Millennial Canadians with a TFSA aren’t investing the money in it (TD survey, Oct 2025).',
  'Round-up apps reward spending more. Nothing rewards spending less.',
]);
await wait(7000);
await card('Leftover: invest what you didn’t spend', [
  'Set weekly budgets. Every Sunday, whatever you didn’t spend in each category gets invested.',
  'n8n is the whole backend: 11 workflows, Data Tables, schedules. Paper trading only.',
]);
await wait(6000);

// 1. Onboarding
await open(`${N8N}/form/lo-onboarding`);
await say('Onboarding is an n8n form: a financial profile, weekly budgets, then an investor quiz.');
await fillFormPage(
  { 'field-2': 0, 'field-3': 0, 'field-4': 1, 'field-5': 1, 'field-6': 2, 'field-7': 1, 'field-8': 0 },
  { 'field-0': 'Dana', 'field-1': FORM_EMAIL },
);
await submitFormPage();
await say('Weekly budgets come prefilled with defaults; every amount is editable.');
await scrollTo(400);
await submitFormPage();
await say('The quiz scores how much risk you can take, and how much you’re willing to take.');
await fillFormPage({ 'field-0': 3, 'field-1': 2, 'field-2': 2, 'field-3': 2, 'field-4': 1, 'field-5': 1, 'field-6': 0 });
await submitFormPage();
await say('The result: a risk tier, a plain-language explanation built from the answers, and a suggested ETF mix.', 6500);
await scrollTo(450);
await say('The mix stays editable, and nothing is invested without the standing-consent box.', 5000);
await scrollTo(99999);
await wait(1200);
const consent = page.locator('form input[type="checkbox"]').last();
if (!(await consent.isChecked())) await click(page.locator(`label[for="${await consent.getAttribute('id')}"]`).first());
await submitFormPage();
await say('Saved to n8n Data Tables: user, profile and budgets.', 3500);

// 2. This week
await open(DASH);
await say('The dashboard only reads and triggers n8n webhooks. This is Maya’s week, live from n8n.');
await moveTo(page.locator('.cat-list > div').nth(1));
await say('She’s under budget on groceries and over on eating out.', 4500);
await caption('A new purchase: $14 at Banh Mi Saigon.');
await runDemoAction('Add sandbox purchase');
if (await page.locator('.demobar-result button', { hasText: 'manual expense' }).count()) {
  await say('No Plaid keys on this instance, so the bank feed is down. The purchase can be logged by hand instead.', 5500);
  await click(page.locator('.demobar-result button', { hasText: 'manual expense' }));
  await page.waitForFunction(() => /Logged/.test(document.querySelector('.demobar-result')?.textContent ?? ''), null, { timeout: 60_000 });
  await wait(1200);
}
await moveTo(page.locator('.cat-list > div').nth(1));
await say('The eating-out bar moved by $14.', 4000);

// 3. The audit
await caption('“Run audit now” triggers the Sunday workflow: LO-04 audits, LO-05 invests, LO-07 writes the digest.');
await runDemoAction('Run audit now');
await say('Each category’s unspent budget is added up. Part tops up the cushion; the rest is the investable leftover.', 6500);
await say('Without Alpaca paper keys the split is computed but no orders are sent. With keys, these become paper orders.', 6000);
await nav('History');
await page.waitForSelector('h1:has-text("History")');
await say('History: every weekly audit, with what was left over, what went to the cushion and what was investable.', 5500);
await scrollTo(520);
await wait(2500);
await scrollTo(0);
await nav('Portfolio');
await page.waitForSelector('h1:has-text("Portfolio")');
await say('Portfolio: positions and orders from the Alpaca paper account. Weekend orders queue until Monday’s open.', 5500);
await nav('Compounding');
await page.waitForSelector('h1:has-text("Compounding")');
await say('Compounding: what the leftovers could grow into. Illustrative, not a prediction.', 4500);
await scrollTo(420);
await wait(2500);
await scrollTo(0);

// 4. The digest
await nav('This week');
await page.waitForSelector('h1:has-text("This week")');
await caption('The weekly digest email.');
await runDemoAction('Send digest');
const details = page.locator('.demobar-result details summary');
if (await details.count()) {
  await say('Gmail isn’t connected here, so n8n returns the email it would have sent.', 4500);
  await click(details);
  await page.locator('.demobar-result pre').evaluate((el) => { el.scrollTop = 150; });
  await say('Subject and body, with the compounding line: illustrative, not a prediction.', 6500);
}

// 5. Settings
await nav('Settings');
await page.waitForSelector('h1:has-text("Settings")');
await say('Settings: the rules the automation stays inside. Budgets, the cushion, and a pause switch.', 5000);
await scrollTo(400);
await wait(2000);

await card('n8n is the whole backend', [
  '11 workflows: onboarding form, bank sync, weekly audit, invest, reconcile, digest, dashboard API, error alerts.',
  'Educational prototype using simulated (paper) trading. Not investment advice. Projections are illustrative.',
]);
await wait(4000);
frames.push({ file: frames.at(-1).file, t: frames.at(-1).t + 4 });

await cdp.send('Page.stopScreencast').catch(() => {});
await browser.close();
await reset();

// ---------------------------------------------------------------- frames -> mp4

const list = frames
  .map((f, i) => `file '${f.file}'\nduration ${Math.max(0.02, (frames[i + 1]?.t ?? f.t + 0.04) - f.t).toFixed(3)}`)
  .join('\n');
writeFileSync(join(FRAMES, 'list.txt'), `${list}\nfile '${frames.at(-1).file}'\n`);
// The submission limit is 3 minutes: speed the whole run up just enough to land under it.
const MAX_SECONDS = 170;
const speed = Math.max(1, (frames.at(-1).t - frames[0].t) / MAX_SECONDS);
const ff = spawnSync(
  'ffmpeg',
  ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(FRAMES, 'list.txt'),
    '-vf', `setpts=PTS/${speed.toFixed(4)},fps=30,format=yuv420p`, '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', OUT],
  { stdio: 'inherit' },
);
if (ff.status !== 0) process.exit(1);
if (!env.FRAMES_DIR) rmSync(FRAMES, { recursive: true, force: true });
console.log(`${OUT}: ${frames.length} frames, ${(frames.at(-1).t - frames[0].t).toFixed(0)} s recorded, played at ${speed.toFixed(2)}x`);
