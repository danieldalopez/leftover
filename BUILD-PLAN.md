# Leftover: parallel build plan

Companion to `spec.md`, the single source of truth. The spec says **what** to build. This file says **who builds what, in what order**, so several Claude Code sessions can work at the same time without stepping on each other. If this file and `spec.md` ever disagree, `spec.md` wins.

---

## The shape

```
WAVE 1 (1 session)            WAVE 2 (6 sessions at once)                          WAVE 3 (1 session)

                         ┌──► A  Audit engine          WF04               ★ critical ──┐
                         ├──► B  Invest + reconcile    WF05, WF06         ★ critical ──┤
 P0  Foundation  ────────┼──► C  Bank data             WF03b, WF02, WF03  (cuttable) ──┼──►  Z  Integration + demo
 contracts, seed,        ├──► D  Onboarding            WF01                          ──┤
 WF00, WF09, stubs       ├──► E  Read API + digest     WF08, WF07                    ──┤
                         └──► F  Dashboard             Next.js app                   ──┘
```

**Why this split works:** Wave 2 lanes never talk to each other directly. They only touch things P0 freezes first:

- the Data Table schemas,
- the webhook routes and their JSON shapes,
- the internal payloads (WF04 → WF05, WF04 → WF07),
- **stub workflows with fixed IDs** for every workflow.

So A can call WF05 before B has built it (it hits B's stub), F can build every page before WF08 exists (it reads fixtures), and B can place orders without waiting for A (it uses a hand-made audit row).

**Fewer sessions?** Run 4: `A` · `B` · `C+D` · `E+F`. Don't merge A and B: they're the critical path (spec M2/M3) and the most independent pair.

---

## Before you start

### Decisions

Recorded in `spec.md` §18. Adopted defaults: overspend drains the cushion (ON), email-only digest, $100 cushion target at a 50% rate. The LLM provider is still open. To change one, change it in the spec.

### What you do by hand (Claude can't create accounts or paste keys for you)

**Nothing is needed to build the n8n side.** P0 runs n8n locally, and sessions push workflows with n8n's own CLI, so there's no n8n API key and no login. P0 also created the `LO Webhook Key` credential.

**Before the demo:** create the n8n owner account at http://localhost:5678 so you can show the canvas.

**Only for the lanes that call outside services** (each lane builds everything up to that call without them):

| Credential (exact name in n8n) | Type | Needed by | Get it at |
|---|---|---|---|
| `Alpaca Paper` | Custom Auth with both `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY` headers | B, E | alpaca.markets → Paper account → API keys |
| `Plaid Sandbox` | Custom Auth that injects `client_id` + `secret` into the request body (keeps them out of JSON and Data Tables; Lane C confirms it works) | C | dashboard.plaid.com → Sandbox keys |
| `LLM` | Anthropic or OpenAI | D, E | your API key |
| `Gmail` | Gmail OAuth2 | E, WF09 | connect in n8n |

---

## Ground rules for every session

1. **Own your files only.** Each lane lists the files it owns. Don't edit anything else. Need a change outside your files (especially `contracts/` or the seed)? Stop and tell Sergio. Don't change it yourself.
2. **One branch per lane.** Work in your own worktree on `lane/<letter>-<name>`. Commit often. Don't merge into `main` yourself; Sergio merges when your "Done when" passes.
3. **Push with `node scripts/n8n.mjs push <your file>`.** No key needed: it imports and publishes through n8n's CLI, and the running n8n serves the new version in ~10–15 s. Keep the file's fixed `id` (`n8n/ids.json`). The JSON in the repo must match what runs in n8n: after any fix made in the n8n UI, `node scripts/n8n.mjs pull <id>`.
4. **Build JSON from `n8n/templates/`**: `node-snippets.json` (node JSON that ran on this n8n), `node-types.json` (full parameter definitions) and `node-versions.json`. Never guess a node's `typeVersion` or parameter shape.
5. **Shared runtime, so isolate your data.** All lanes share one n8n instance, one set of Data Tables and one Alpaca paper account.
   - Write test data only under your lane's test user: `test-a` … `test-f`.
   - `maya` (the demo user) is read-only, except for Lane A, P0 and Z.
   - Only Lane A, P0 and Z call `POST /lo/demo/reset` (it only touches Maya's rows).
6. **Logic as pure functions first.** Put the math in `lib/<area>.mjs` as plain functions with no imports and no npm packages (so they paste straight into a Code node). Test with `node --test`. Then paste the same functions into the Code node, plus an inline self-test where the spec asks for one.
7. **Test through webhooks.** Every workflow has a webhook trigger. Call it with `node scripts/n8n.mjs call POST lo/<route> '<json>'` (adds `x-lo-key`). To see what landed in a table, use the read-only `sqlite3` one-liner in `n8n/CONVENTIONS.md`.
8. **Write down what Z needs** in `n8n/notes/<letter>.md`: credentials used, how to test, anything stubbed or skipped, known gaps. Z turns these into `n8n/README.md`.
9. **No secrets in the repo.** Credentials are referenced by name and ID; keys live in n8n and `.env` (gitignored).
10. **Paper trading only.** Never a live Alpaca URL.

---

## Wave 1: P0 Foundation (one session, run first) ✅ done 2026-11-14

**Goal:** everything the six Wave 2 lanes need to start without waiting on each other. Ends at spec milestone M1.

**Result:**
- n8n 2.47.7 runs via `npx`; all 11 workflows are imported with fixed IDs, and 9 are published.
- `POST /lo/demo/reset` creates every table and seeds Maya (1 user, 7 budgets, 43 transactions). Running it twice changes nothing.
- All 13 stub routes answer; a wrong key gets 403.
- Departures from the task list below:
  - no Docker (`npx` instead);
  - no API key (CLI push instead);
  - tables are referenced by name, so no table IDs need recording;
  - node snippets come from workflows that actually ran, plus full node definitions, instead of a throwaway export.

**Owns:** `CLAUDE.md`, `.gitignore`, `.env.example`, `contracts/**`, `n8n/CONVENTIONS.md`, `n8n/templates/**`, `lib/week.mjs` (+ test), `demo/seed-data.json`, `n8n/workflows/00-setup-and-seed.json`, `n8n/workflows/09-error-handler.json`.

**Tasks**
1. **Scaffold** the repo per spec §0. `git init`, first commit, `.env` in `.gitignore`.
2. **n8n running** (Docker per spec 16.1, timezone `America/Vancouver`; fall back to `npx n8n` if Docker isn't installed). Record the exact version in CONVENTIONS.md.
3. **Reference snippets.** Build one throwaway workflow containing every node type the project uses (Webhook, Schedule Trigger, Form Trigger, Form, Code, Data Table, HTTP Request, If, Merge, Execute Workflow, Execute Workflow Trigger, Respond to Webhook, Error Trigger, Gmail, the LLM chat node). Fetch it through the API and save it as `n8n/templates/node-snippets.json`. This is what makes every lane's JSON import cleanly (spec risk R2).
4. **Answer two Data Table questions** in CONVENTIONS.md:
   - Can the Data Table node create tables, or must they be created another way (UI or API)?
   - Can nodes reference a table **by name**, or only by ID? (If ID only, importing into a fresh instance needs a re-link step; Z handles it.)
5. **Create the tables** from spec §9 with exact column names and types, documented in `contracts/data-tables.md`. Record each table ID in CONVENTIONS.md.
6. **Stub workflows.** Create every workflow (LO-01 … LO-08, including 03b) in n8n with its final name and webhook routes, each returning `{"ok": true, "stub": true}`. Record every workflow ID and credential ID in CONVENTIONS.md. Lanes overwrite their own stub, so IDs never change and cross-lane Execute Workflow calls work from day one.
7. **API contract** in `contracts/api.md` plus `contracts/fixtures/<endpoint>.json`: for each WF08 endpoint, the exact response JSON with a realistic example for Maya, following the response format in `spec.md` §19.2.
8. **Webhook + payload contract** in `contracts/webhooks.md`: the exact request and response for every route and internal call in `spec.md` §19.1, including what WF05 returns to WF04.
9. **`lib/week.mjs`**: `weekStart`, `weekEnd`, `daysLeft`, all in America/Vancouver. Tests include a week containing a DST change (Sun Nov 1, 2026) and a transaction at Sunday 23:30 local.
10. **`demo/seed-data.json`**: Maya, 7 budgets, a balanced profile, 4 weeks of transactions. Store dates as **day offsets from the current week's Monday** so the seed always lands on "this week" whenever you demo. Tell the spec §15 story (under on groceries, over on eating out) and include a refund, a pending → posted pair, and a few excluded items (rent, a transfer) so Lane A's edge cases have data.
11. **WF00 Setup and Seed** (create or clear tables, seed config, category_map, Maya, transactions; `POST /lo/demo/reset` resets Maya's rows only). **WF09 Error handler** (Error Trigger → email; if Gmail isn't connected yet, leave the credential for Z to attach).
12. **`CLAUDE.md`**: short pointer to `spec.md`, `BUILD-PLAN.md`, `contracts/`, `n8n/CONVENTIONS.md` and the ground rules above.

**Done when:** `POST /lo/demo/reset` fills every table with Maya's 4 weeks; every stub answers on its route; `contracts/` and `CONVENTIONS.md` are committed on `main`. Then start Wave 2.

### Who owns which workflow

Routes, request bodies and internal payloads are defined in `spec.md` §19.1. Ownership:

| Workflow | Lane |
|---|---|
| LO-00 Setup and Seed, LO-09 Error Handler | P0 |
| LO-01 Onboarding Form | D |
| LO-02 Plaid Connect, LO-03 Transaction Sync, LO-03b Manual Expense | C |
| LO-04 Weekly Audit | A |
| LO-05 Invest Executor, LO-06 Order Reconcile | B |
| LO-07 Weekly Digest, LO-08 Dashboard API | E |

---

## Wave 2: six lanes in parallel

### Lane A: Audit engine (WF04) ★ critical

**Owns:** `n8n/workflows/04-weekly-audit.json`, `lib/audit.mjs` + tests, `n8n/notes/A.md`
**Reads:** spec §6 (all of it), §10 WF04, `contracts/`.

**Build**
1. `lib/audit.mjs`, pure functions for:
   - spend per category: refunds, pending dedupe via `pending_txn_id`, excluded categories (6.2, 6.3);
   - under/over per category, no netting (6.4);
   - cushion fill and overspend absorption (6.5);
   - late-posting true-up (6.6);
   - investable amount with carries, cap and minimum (6.7).

   Tests must cover the 6.8 worked example exactly ($26 gross, buffer 60 → 39 → 52, investable $13), plus: paused user, week already invested, below-minimum carry, cap hit, late-posting shrink, refund bigger than the week's spend.
2. WF04: Schedule (Sunday 20:00 America/Vancouver) + webhook `POST /lo/audit/run {user_id?, week_start?, invest?}`, merged into one path. Data Table fetch → Code (lib functions + inline 6.8 self-test that throws) → upsert audit (idempotent on `audit_id`; stop if already `invested`) → update the user's buffer and carries → if investable ≥ `min_invest`, Execute Workflow LO-05 (B's stub until B lands) → Execute LO-07.
3. `invest: false` writes the audit without calling WF05, so Z can backfill past weeks for the History page.

**Test with:** `maya` for the real story, `test-a` for crafted edge cases.
**Done when:** unit tests pass; `POST /lo/audit/run` for Maya writes the correct audit; running it twice changes nothing; it calls the LO-05 stub with the contract payload. (spec M2)
**Watch out:** Code nodes can't read Data Tables: always Data Table node → Code → Data Table node. Week boundaries come from `lib/week.mjs`.

### Lane B: Invest + reconcile (WF05, WF06) ★ critical

**Owns:** `n8n/workflows/05-invest-executor.json`, `06-order-reconcile.json`, `lib/allocate.mjs` + tests, `n8n/notes/B.md`
**Reads:** spec §6.9, §10 WF05 and WF06, §11.5, §12, `contracts/`.

**Build**
1. Check VTI, VXUS, EWC, BND and SGOV are `fractionable` via `GET /v2/assets/{symbol}`, and look up Alpaca's current minimum notional. Write the results in your notes. If a ticker isn't fractionable, propose a substitute to Sergio (it's a config change P0 owns).
2. `lib/allocate.mjs`: tier + home bias → sleeve weights (11.5); CAD → USD; split to cents; fold sleeves under the minimum into the largest; the total is preserved to the cent. Tests.
3. WF05: Execute Workflow Trigger `{audit_id, user_id, investable_cad}` + webhook `POST /lo/invest/run`. Load allocation → FX rate (Frankfurter, fallback `fx_fallback_usdcad` from config) → one order per sleeve with `client_order_id = {audit_id}-{symbol}` → a duplicate `client_order_id` counts as success → write `orders` rows, set audit status `invested`, adjust `pending_carry`. Return the contract response.
4. WF06: hourly Mon–Fri schedule + `POST /lo/reconcile/run`. For non-terminal orders, `GET /v2/orders:by_client_order_id` → update status, fills, `filled_at`. Rejected → one retry with suffix `-r1`, then throw so WF09 alerts.

**Test with:** `test-b`. Insert a fake profile and audit row yourself and call `/lo/invest/run` directly; you don't need Lane A.
**Done when:** orders show up in the Alpaca paper dashboard; calling twice creates no duplicates; reconcile updates statuses. On a weekend, `accepted` / queued is the correct result (spec §12). (spec M3)
**Watch out:** base URL must be `https://paper-api.alpaca.markets`. Store both CAD and USD amounts and the FX rate on every order.

### Lane C: Bank data (WF03b → WF02 → WF03) · cuttable

**Owns:** `n8n/workflows/02-plaid-connect-sandbox.json`, `03-transaction-sync.json`, `03b-manual-expense.json`, `lib/categorize.mjs` + tests, `n8n/notes/C.md`
**Reads:** spec §6.2, §6.3, §9 (transactions, bank_links, category_map), §10 WF02, WF03, WF03b.

**Build, in this order** (so the demo fallback exists even if Plaid takes long):
1. WF03b manual expense: Form "Log a purchase" + `POST /lo/expense` → transaction with `source: "manual"`, category validated against budgets.
2. `lib/categorize.mjs`: Plaid PFC primary/detailed → `category_key` using `category_map` rows; excluded flag; sign convention; pending → posted dedupe. Check the PFC names against current Plaid docs (the spec says verify). If the `category_map` seed needs changes, tell Sergio (P0 owns the seed).
3. WF02: `POST /lo/plaid/connect-sandbox` → `/sandbox/public_token/create` (dynamic transactions test user) → `/item/public_token/exchange` → `bank_links` → call LO-03.
4. WF03: 6-hour schedule + `POST /lo/sync` → `/transactions/sync` looping while `has_more`; handle added / modified / removed; upsert by `txn_id`; save the cursor. Plus `POST /lo/demo/add-txn` → `/sandbox/transactions/create` → `/transactions/refresh` → sync.

**Test with:** `test-c` (link the sandbox bank to `test-c`, not Maya; Z decides how Maya's demo bank works).
**Done when:** the manual form writes a transaction; a purchase via `/lo/demo/add-txn` lands in `transactions` with the right category after sync. (spec M6)
**Watch out:** Plaid keys only through the `Plaid Sandbox` credential, never in workflow JSON or Data Tables.

### Lane D: Onboarding (WF01)

**Owns:** `n8n/workflows/01-onboarding-form.json`, `lib/scoring.mjs` + tests, `n8n/notes/D.md`
**Reads:** spec §7 F1, §10 WF01, §11, §14.

**Build**
1. `lib/scoring.mjs`: answers → capacity and willingness scores (0–100) → tier for each → final tier = the lower one; horizon under 3 years forces cash; warnings (11.4); `allocation_json` from 11.5 and home bias. Tests for every tier boundary and both hard rules.
2. WF01: multi-page Form (financial profile; weekly budgets prefilled with defaults; investor quiz; result page with editable allocation and consent checkbox) → Code → LLM explanation (3–4 sentences, general language, no buy/sell/hold of specific securities) → write `users`, `budgets`, `profiles` → final page links to the dashboard.

**Test with:** onboard as `test-d`. Decide how the form identifies a user (email → `user_id`) and write it in your notes.
**Done when:** a new user completes the form end to end and their rows appear in all three tables with a sensible tier. (spec M5)
**Watch out:** compliance wording (spec §14). Save the user's edited allocation, not just the computed one.

### Lane E: Read API + digest (WF08, WF07)

**Owns:** `n8n/workflows/07-weekly-digest.json`, `08-dashboard-api.json`, `lib/projection.mjs` + tests, `scripts/check-api.mjs`, `n8n/notes/E.md`
**Reads:** spec §10 WF07 and WF08, §13 (what each page needs), `contracts/api.md` (you implement it exactly).

**Build**
1. `lib/projection.mjs`: `FV = amount × (1 + r)^years` for 4/6/8% over 10/20/30 years; lifetime contributions; per-category "your choices" streaks; projected leftover at the current pace (for the summary). Tests.
2. WF08: the five endpoints, header auth `x-lo-key`, each ending in Respond to Webhook with JSON matching `contracts/fixtures/`. The portfolio endpoint pulls Alpaca positions plus the latest quote, so queued orders show an estimated value (spec §12).
3. `scripts/check-api.mjs`: calls each live endpoint and compares its shape to the fixture. Z reuses it.
4. WF07: Execute Workflow Trigger + `POST /lo/digest/send {user_id, audit_id?}` → category scoreboard, invested this week, buffer, lifetime invested, portfolio value, FV lines → LLM summary (80–120 words, rules in spec §10 WF07) → Gmail.

**Test with:** `maya` read-only for transactions and budgets; until Lane A lands, insert your own audits and orders under `test-e`.
**Done when:** `check-api.mjs` passes for all five endpoints; the digest email arrives with the projection line. (spec M7, API half of M4)
**Watch out:** no polling anywhere. On n8n Cloud every webhook call is an execution.

### Lane F: Dashboard (Next.js)

**Owns:** `dashboard/**`, `n8n/notes/F.md`
**Reads:** spec §13, `contracts/api.md`, `contracts/fixtures/`, `contracts/webhooks.md` (for the demo bar).

**Build**
1. Next.js app whose server routes proxy to n8n, so `N8N_WEBHOOK_KEY` never reaches the browser. With `MOCK=1` the routes serve the fixtures instead, so every page works before WF08 exists. Copy the fixtures into `dashboard/mocks/` with a small script (Vercel only sees `dashboard/`).
2. Pages: This week, History, Portfolio, Compounding, Settings (spec §13). Disclaimer footer on every page. Demo control bar when `demo_mode` is true.
3. Order status chips include "Queued · fills at Monday's open" with the estimated value, so the weekend demo doesn't look broken (spec §12, R1).
4. Fetch on page load and on button press only. Never poll.

**Test with:** mock mode first, then `MOCK=0` against local n8n as WF08's endpoints go live.
**Done when:** all five pages render from fixtures and from live n8n; `npm run build` passes; a Vercel preview deploys in mock mode. (spec M4)
**Watch out:** the n8n canvas is the star of the demo; the dashboard is the proof. Clean and readable beats fancy.

---

## Wave 3: Z Integration + demo (one session)

**Start when A and B are merged.** Fold in C–F as they land.
**Owns:** merging, wiring, `n8n/README.md`, `demo/demo-script.md`, and fixes anywhere (no other lane is running by then).

1. Merge lane branches into `main` (Sergio approves each one).
2. Wire the real chain: WF04 → WF05 → WF07; WF02 → WF03; reset → backfill Maya's past 3 weeks through WF04 (decide `invest: false` vs real paper orders) so History isn't empty.
3. Set WF09 as the error workflow on every workflow; activate the schedules; confirm the instance timezone.
4. Dashboard live: public n8n URL (n8n Cloud trial or a tunnel), Vercel env vars (`N8N_BASE_URL`, `N8N_WEBHOOK_KEY`, `DEMO_USER_ID`), demo bar buttons hitting real routes.
5. **Fresh-instance test:** import all 11 JSON files into a clean n8n (a new Docker volume, or the Cloud trial; start the trial now, not earlier, because its 14 days and 1,000 executions start counting). Fix any ID re-linking (tables, sub-workflows, credentials) and write the import order into `n8n/README.md` from the lanes' notes.
6. Run the spec §15 demo script twice in a row cleanly. Record the backup video. Write `demo/demo-script.md`. (spec M8)

**Cut order if time runs short** (spec §17): ESG → Telegram → debt mode → Lane C's Plaid parts (keep WF03b and the seed). Never cut A or B.

---

## Starting the sessions

When P0 is merged, start each Wave 2 session in its own worktree with this prompt (swap the letter and branch):

> You are **Lane A** of the Leftover build, on branch `lane/a-audit`. Read `CLAUDE.md`, then `BUILD-PLAN.md` (the ground rules and the Lane A section), the spec sections that section lists, `contracts/` and `n8n/CONVENTIONS.md`. Build only Lane A. Stop when its "Done when" passes, and write `n8n/notes/A.md`.

| Lane | Branch |
|---|---|
| A | `lane/a-audit` |
| B | `lane/b-invest` |
| C | `lane/c-bank` |
| D | `lane/d-onboarding` |
| E | `lane/e-api-digest` |
| F | `lane/f-dashboard` |

Z uses the same prompt pattern with "Wave 3: Z Integration + demo".
