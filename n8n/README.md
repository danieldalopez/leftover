# Leftover on n8n: set up an instance

The 11 workflows in `n8n/workflows/` are the whole backend. The data lives in n8n Data Tables, which LO-00 creates. This page takes a clean n8n to a working demo. Tested on 2026-11-15: an empty n8n 2.47.7 set up with these steps passed every smoke check (reset + backfill, invest dry run, digest, expense, form, API contract).

## 1. Start n8n (self-hosted, pinned version)

```bash
PATH="$PWD/n8n/icu-tz/bin:$PATH" GENERIC_TIMEZONE=America/Vancouver TZ=America/Vancouver N8N_DIAGNOSTICS_ENABLED=false npx -y n8n@2.47.7
```
In the Claude desktop app this is the preview server `leftover-n8n` (port 5678). The timezone matters: the Sunday audit and the order checks are scheduled in Vancouver time. `n8n/icu-tz/bin` on `PATH` gives n8n (and its Code-node runner) timezone data that knows BC is on UTC−7 all year since Nov 1, 2026; see `n8n/icu-tz/README.md`.

## 2. Load everything (one command)

`.env` (copy `.env.example`) needs `N8N_WEBHOOK_KEY` (any long random string) and `N8N_BASE_URL`.

```bash
node scripts/setup-instance.mjs
```
It does three things:
1. **Credentials.** It creates `LO Webhook Key` from `.env`. It also creates `Plaid Sandbox` and `Alpaca Paper` with placeholder values if they don't exist yet; an existing credential is never overwritten.
2. **Workflows.** It imports all 11 and publishes them in this order: LO-09, LO-05, LO-07, LO-04, LO-00, LO-03, LO-02, LO-03b, LO-01, LO-06, LO-08. A workflow that calls another can only be published after it (n8n 2.47: "publish all referenced sub-workflows first").
3. **IDs.** Every workflow and credential keeps its fixed ID from `n8n/ids.json`, so sub-workflow calls and credentials never need re-linking.

Then seed the data (it also creates every Data Table):
```bash
node scripts/n8n.mjs call POST lo/demo/reset '{}'
```
Maya comes back with 43 transactions, 7 budgets and her 3 past weeks audited (`invest: false`): $45.18, $27.25 and $26.15 investable, cushion $41.00.

To push a single workflow after a change: `node scripts/n8n.mjs push n8n/workflows/<file>.json`.

## 3. Credentials (Sergio enters the keys; nothing secret is in the repo)

| Credential | Status after setup | What to do |
|---|---|---|
| `LO Webhook Key` (`leftoverCredHook`) | ready | nothing |
| `Plaid Sandbox` (`leftoverCredPlad`) | placeholder | n8n → Credentials → Plaid Sandbox → replace the JSON with `{"body":{"client_id":"…","secret":"…"}}` (sandbox keys) |
| `Alpaca Paper` (`leftoverCredAlpc`) | placeholder | replace the JSON with `{"headers":{"APCA-API-KEY-ID":"…","APCA-API-SECRET-KEY":"…"}}` (paper keys) |
| `LLM` | not used (spec D4) | the onboarding explanation and the digest summary use fixed template text. To switch to Claude-written text later: create an Anthropic credential named `LLM`, then tell Claude to record its ID in `n8n/ids.json` and turn on LO-01 "Explain (LLM)" and LO-07 "Digest: LLM summary" + "LLM chat model" |
| `Gmail` | missing | self-hosted n8n needs your own Google Cloud OAuth client (Client ID + Secret, redirect `http://localhost:5678/rest/oauth2-credential/callback`). Create a Gmail OAuth2 credential named `Gmail`, then tell Claude: it turns on LO-07 "Digest: send email" and LO-09 "Send alert email" |

Until a key exists, that step falls back (spec §19.5):
- **No Alpaca:** the audit stays `computed` and nothing is invested. The dashboard prices positions at the last fill price.
- **No LLM (the current choice, D4):** fixed template texts are used.
- **No Gmail:** the digest returns the email it would have sent, with `502`.
- **No Plaid:** use the manual expense route and the seed.

## 4. Config (Data Tables → `config`)
- `dashboard_url`: seeded as `https://leftover-rosy.vercel.app`.
- `demo_email_to`: empty. Put the address that should receive Maya's digest here (once Gmail is connected).

A reset keeps both values if they're already set.

## 5. What runs on its own
| Workflow | Schedule (Vancouver) |
|---|---|
| LO-04 Weekly Audit | Sunday 20:00: every active user, current week, then invest (LO-05) and digest (LO-07) |
| LO-03 Transaction Sync | every 6 hours, every bank link |
| LO-06 Order Reconcile | hourly 06:00–14:00, Monday to Friday |

**Errors:** every workflow reports failures to **LO-09 Error Handler**. LO-09 must be published, or n8n skips it ("is not active and cannot be executed"); setup publishes it. Its email step stays off until Gmail exists, so until then failures show up only in n8n's Executions list.

Routes that catch an exception still answer `500 INTERNAL`. After the reply they fail the run on purpose, so LO-09 hears about it.

## 6. Making it public (for the Vercel dashboard)
The dashboard on Vercel (https://leftover-rosy.vercel.app) needs to reach n8n over the internet.

**What's set up (nothing to install):** start the preview server `leftover-public`, or run `node scripts/public-tunnel.mjs --update-vercel`.
- **Webhook-only proxy.** A small proxy on `127.0.0.1:5699` forwards only `/webhook/*` to the local n8n. The editor, `/rest`, `/form` and the owner-setup page answer 404 from outside, so the n8n UI is never public, owner account or not. The webhooks still need `x-lo-key`.
- **Tunnel.** macOS's built-in `ssh` opens a tunnel to localhost.run (free, no account) and gets a URL like `https://<id>.app.lhr.life`.
- **Re-pointing Vercel.** The free domain rotates now and then. With `--update-vercel`, every new URL runs `scripts/vercel-live.mjs <url>`, which checks the URL answers, sets `MOCK=0`, `N8N_BASE_URL`, `N8N_WEBHOOK_KEY` (from `.env`, never printed) and `DEMO_USER_ID=maya`, and redeploys. It takes about a minute, during which the dashboard shows its "Mock data" badge.
- **Going dark.** Stop `leftover-public` to take the webhooks offline. `node scripts/vercel-live.mjs off` puts Vercel back on sample data.
- **Caution.** Anyone with the Vercel URL can press the demo buttons, Reset included, and they act on this Mac's n8n.

Other options:
- **n8n Cloud.** There's no CLI there, and importing a file through the UI gives each workflow a new ID. After importing (same order as above), re-point the 5 sub-workflow calls by hand: LO-04 → LO-05 and LO-07, LO-00 → LO-04, LO-02 → LO-03, and LO-03b → itself. Then create the credentials with the same names and select them on their nodes. This path is untested.

## 7. Checks
```bash
npm test                          # pure logic + seed + fixtures
node scripts/check-api.mjs        # live dashboard API against contracts/fixtures
node scripts/demo-rehearsal.mjs   # the spec §15 demo, step by step, against the live routes
```
