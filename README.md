# Leftover

**Invest what you didn't spend.** Set a weekly budget per category. Every Sunday at 8 pm, whatever you didn't spend in each category is added up: part tops up a cash cushion, and the rest is invested in an ETF mix that matches your risk profile.

Built for the Loop Hackathon (eProjects × n8n). The n8n workflows are the whole backend; the dashboard only reads and triggers them.

- **Dashboard:** https://leftover-rosy.vercel.app (live while the n8n host and tunnel are running; sample data otherwise)
- **Demo video (under 3 min, narrated):** [`demo/leftover-demo.mp4`](demo/leftover-demo.mp4)
- **Status and next steps:** [`STATUS.md`](STATUS.md)

> Educational prototype using simulated (paper) trading. Not investment advice. Projections are illustrative.

## How it works

1. **Onboarding** (n8n form): a financial profile, weekly budgets and an investor quiz produce a risk tier and a suggested ETF mix, which stays editable. Nothing is invested without standing consent.
2. **During the week**: transactions arrive from Plaid's sandbox, or are logged by hand, and are mapped to budget categories.
3. **Sunday audit**: each category's unspent budget is added up (categories aren't netted against each other). Overspending comes out of the cushion, a share of the leftover refills it, and the rest becomes paper orders on Alpaca. A digest email follows.

## Built with AI, on rules

The whole project was built with AI from a written spec: `spec.md` and the frozen `contracts/` came first, then six Claude Code sessions built the workflows in parallel, one lane each (`BUILD-PLAN.md`, `n8n/notes/`).

Anything that decides how much is invested is deterministic JavaScript with tests. The language-model steps (the risk explanation and the digest summary) sit in the workflows behind a validator, with a template as the default.

## The workflows

| | Workflow | Runs |
|---|---|---|
| LO-00 | Setup and Seed | creates the Data Tables, seeds the demo user, resets the demo |
| LO-01 | Onboarding Form | n8n form at `/form/lo-onboarding` |
| LO-02 | Plaid Connect Sandbox | links a sandbox bank |
| LO-03 | Transaction Sync | every 6 hours, and on demand |
| LO-03b | Manual Expense | logs a purchase by hand |
| LO-04 | Weekly Audit | Sunday 20:00 (Vancouver), and on demand |
| LO-05 | Invest Executor | called by the audit; places Alpaca paper orders |
| LO-06 | Order Reconcile | hourly on weekdays; updates fills |
| LO-07 | Weekly Digest | called by the audit; builds and sends the email |
| LO-08 | Dashboard API | four read routes and a settings route |
| LO-09 | Error Handler | error workflow for all of the above |

## What's in the repo

| Path | What |
|---|---|
| `spec.md` | the source of truth: rules, decisions (§18), locked conventions (§19) |
| `n8n/workflows/` | the 11 workflows as JSON, with fixed IDs |
| `lib/` | the pure logic (audit, allocation, scoring, categorizing, projections), tested with `node --test` and pasted verbatim into the Code nodes |
| `contracts/` | Data Table schemas, webhook routes, API shapes and fixtures |
| `dashboard/` | Next.js front end (five pages and a demo bar) |
| `scripts/` | set up an instance, push and call workflows, check the API, rehearse the demo |
| `demo/` | the demo script, the seed data, the video and the script that records it |

## Run it

Tested on Node 26. n8n runs with `npx`; nothing else is installed.

```bash
cp .env.example .env    # set N8N_WEBHOOK_KEY to any long random string
```
```bash
PATH="$PWD/n8n/icu-tz/bin:$PATH" GENERIC_TIMEZONE=America/Vancouver TZ=America/Vancouver N8N_DIAGNOSTICS_ENABLED=false npx -y n8n@2.47.7
```
```bash
node scripts/setup-instance.mjs
```
```bash
node scripts/n8n.mjs call POST lo/demo/reset '{}'
```
```bash
cd dashboard && npm install && npm run dev
```

Full setup, credentials and how the public link works: [`n8n/README.md`](n8n/README.md).

## Keys

Everything runs without third-party keys; each missing key makes its step take a documented fallback (spec §19.5). The keys go into n8n credentials, never into the repo.

| Service | n8n credential | Without it |
|---|---|---|
| Alpaca (paper) | `Alpaca Paper` | the audit computes the split but sends no orders |
| Plaid (sandbox) | `Plaid Sandbox` | purchases are logged by hand |
| Gmail | `Gmail` (OAuth2) | the digest returns the email it would have sent |

## Checks

```bash
npm test
```
```bash
node scripts/check-api.mjs
```
```bash
node scripts/demo-rehearsal.mjs
```
