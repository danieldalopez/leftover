#!/usr/bin/env node
// scripts/public-tunnel.mjs: give the local n8n's webhooks a public https URL, with nothing to install.
//
//   node scripts/public-tunnel.mjs        (or the preview server `leftover-public`)
//
// 1. A tiny proxy on 127.0.0.1:5699 forwards ONLY /webhook/* to the local n8n (localhost:5678).
//    Everything else (the editor, /rest, /form, the owner-account setup page) answers 404, so the
//    n8n UI is never public. The webhooks themselves still need the x-lo-key header.
// 2. macOS's built-in ssh opens a tunnel to localhost.run (free, no account, no key), which prints
//    a public URL like https://<id>.lhr.life. It's logged as "PUBLIC_URL <url>".
// 3. If the tunnel drops it reconnects, and the free domain also rotates now and then, so the URL can
//    change. Point Vercel at the new one with `node scripts/vercel-live.mjs <url>`, or start this
//    script with --update-vercel to do that automatically (the preview server `leftover-public` does).
//
// Stop it to take the webhooks offline again (Vercel then falls back to its "Mock data" badge).

import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PROXY_PORT || 5699);
const TARGET = new URL(process.env.N8N_LOCAL_URL || 'http://localhost:5678');
const URL_RE = /https:\/\/[a-z0-9.-]+\.lhr\.life/i; // e.g. https://fbf6d17aadc25e.app.lhr.life
const AUTO_VERCEL = process.argv.includes('--update-vercel');

const server = http.createServer((req, res) => {
  if (!req.url || !req.url.startsWith('/webhook/')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const upstream = http.request({
    hostname: TARGET.hostname, port: TARGET.port, method: req.method, path: req.url,
    headers: { ...req.headers, host: TARGET.host },
  }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.setTimeout(120_000, () => upstream.destroy(new Error('timeout')));
  upstream.on('error', (e) => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'UPSTREAM_ERROR', message: `local n8n not reachable (${e.message})` } }));
  });
  req.pipe(upstream);
});

// --update-vercel: the free localhost.run domain rotates now and then, so re-point the Vercel dashboard
// each time a new URL shows up (scripts/vercel-live.mjs checks the URL answers, then redeploys).
let vercelRun = Promise.resolve();
function pointVercel(url) {
  vercelRun = vercelRun.then(() => new Promise((done) => {
    console.log(`pointing Vercel at ${url} ...`);
    const p = spawn('node', [new URL('./vercel-live.mjs', import.meta.url).pathname, url], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => process.stdout.write(`[vercel] ${d}`));
    p.stderr.on('data', (d) => process.stdout.write(`[vercel] ${d}`));
    p.on('exit', (code) => { if (url !== lastUrl) console.log('[vercel] (a newer URL arrived meanwhile; it is queued)'); console.log(`[vercel] done (exit ${code})`); done(); });
  }));
}

let lastUrl = '';
function startTunnel() {
  const ssh = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes', '-R', `80:127.0.0.1:${PORT}`, 'nokey@localhost.run',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (chunk) => {
    const m = String(chunk).match(URL_RE);
    if (m && m[0] !== lastUrl) {
      lastUrl = m[0];
      console.log(`PUBLIC_URL ${lastUrl}`);
      if (AUTO_VERCEL) pointVercel(lastUrl);
      else console.log(`webhooks: ${lastUrl}/webhook/...   (point Vercel at it: node scripts/vercel-live.mjs ${lastUrl})`);
    }
  };
  ssh.stdout.on('data', onData);
  ssh.stderr.on('data', onData);
  ssh.on('exit', (code) => {
    console.log(`tunnel closed (ssh exit ${code}); reconnecting in 5 s`);
    setTimeout(startTunnel, 5000);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`webhook-only proxy on http://127.0.0.1:${PORT} -> ${TARGET.origin}/webhook/*`);
  startTunnel();
});
