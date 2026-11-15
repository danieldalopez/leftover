# Lane B notes: Invest + reconcile (LO-05, LO-06)

Status 2026-11-14: **built and live in n8n up to the Alpaca calls.** The `Alpaca Paper` credential doesn't exist yet, so every real-order path stops at the account check, as spec §19.5 says. The Data Table writes after it were exercised on `test-b` with simulated Alpaca answers (see "What was proven").

## Files
| File | What |
|---|---|
| `lib/allocate.mjs` | All Lane B logic as pure functions: weights (§11.5), FX pick, the split to the cent, Alpaca response handling, request validation (`planInvest`), the reply (`finishInvest`, `upstreamResult`), and reconcile decisions (`planReconcile`, `finishReconcile`). |
| `lib/allocate.test.mjs` | 35 tests. It reproduces every order in `contracts/fixtures/portfolio.json` to the cent, fuzzes 2,000 splits (totals preserved, every order ≥ $1 USD), and checks that the workflows embed the lib verbatim. |
| `n8n/workflows/05-invest-executor.json` | `LO-05 Invest Executor` (`leftoverWF05invs`), published. |
| `n8n/workflows/06-order-reconcile.json` | `LO-06 Order Reconcile` (`leftoverWF06recn`), published, schedule active (see below). |

The Code nodes that need the lib embed everything above `export {` in `lib/allocate.mjs`, between the markers `// ---- lib/allocate.mjs ----` and `// ---- end of lib/allocate.mjs ----`: 3 nodes in LO-05, 4 in LO-06. After changing the lib, re-paste it into all of them and run `npm test`. The last test fails if any copy is stale.
```bash
node -e 'const fs=require("fs");const lib=fs.readFileSync("lib/allocate.mjs","utf8");const body=lib.slice(0,lib.indexOf("\nexport {")).trim();for(const f of process.argv.slice(1)){const w=JSON.parse(fs.readFileSync(f,"utf8"));for(const x of w.nodes){const c=x.parameters&&x.parameters.jsCode;if(!c||!c.includes("// ---- lib/allocate.mjs ----"))continue;const a=c.indexOf("\n",c.indexOf("// ---- lib/allocate.mjs ----"))+1,b=c.indexOf("\n// ---- end of lib/allocate.mjs ----");x.parameters.jsCode=c.slice(0,a)+body+c.slice(b)}fs.writeFileSync(f,JSON.stringify(w,null,2)+"\n")}' n8n/workflows/05-invest-executor.json n8n/workflows/06-order-reconcile.json
```

## LO-05 Invest Executor
Triggers: `POST /lo/invest/run` (Respond to Webhook, real status codes) and Execute Workflow `Called by LO-04` (passthrough). Both feed one path:

1. **Read**: request → user, profile, audit, this audit's orders, config → USD/CAD from Frankfurter (`https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD`; on failure the node outputs `{error}` and the config fallback is used).
2. **Plan orders** (`planInvest`):
   - validation → `BAD_REQUEST` / `NOT_FOUND`;
   - `dry_run` → reply with the would-be orders, write nothing;
   - audit already `invested` → reply with its stored orders, place nothing (idempotent).
3. **Alpaca: check account** (`GET /v2/account`). Missing credential, bad keys, no answer or a blocked account → `UPSTREAM_ERROR` (502) with the computed split, every order `dry_run`. Nothing is sent or written and the audit stays `computed` (§19.5).
4. **Submit** one order per sleeve: `POST /v2/orders` with `{symbol, notional: "6.81", side: "buy", type: "market", time_in_force: "day", client_order_id: "{audit_id}-{symbol}"}`.
5. **Confirm** each with `GET /v2/orders:by_client_order_id`. The lookup is the source of truth: a POST that failed but whose lookup finds the order is a duplicate (`duplicate: true`), which counts as success. I don't parse Alpaca's error text for "duplicate".
6. **Save** the placed orders (upsert on `client_order_id`, both CAD and USD plus `fx_rate`). If every order was placed: audit → `invested`, `users.pending_carry = max(pending_carry − invested_cad, 0)`. If any order was refused, the reply is `status: "partial"` + `UPSTREAM_ERROR` and the audit stays `computed`. A re-run reuses the FX rate stored on that audit's orders, so amounts match and Alpaca dedupes the orders already placed.

Guards (all in `planInvest`):
- `alpaca_base_url` must be exactly `https://paper-api.alpaca.markets`, else `INTERNAL`;
- `audit_id` must start with `{user_id}-`;
- for real runs: the audit must exist, belong to the user and be `computed`; the user must not be `paused` and must have `consent_at`;
- the amount must be within [`min_invest`, `max_weekly_invest`];
- a broken `allocation_json` is an error, not a silent fallback (only a *missing* allocation falls back to tier + home bias).

### The split (`allocate`)
- CAD is split to the cent by weight with largest remainder, so the total is preserved.
- USD total = CAD total ÷ fx, rounded to the cent, then split in proportion to the CAD amounts, also by largest remainder.
- Any sleeve under **$1 USD** (Alpaca's minimum) folds into the largest sleeve; repeat until every order clears $1.
- The minimum is applied in **USD**. The fixture proves it: maya-2026-10-19's EWC is CAD 1.36 = USD 0.99, and it is folded.
- The FX rate is rounded to 4 decimals and stored on every order.
- With the balanced/global mix, EWC (3%) only clears $1 USD from about CAD 47.50 invested (at 1.4258), so for typical weeks it folds into BND. That matches the fixtures. With more_canada (18% EWC) it folds only below about CAD 8.

### Contract for LO-04 (Lane A)
- Call with `{audit_id, user_id, investable_cad}` **after** upserting the audit as `computed` with that `investable_cad`. A mismatch with the audit row only adds a `warnings` entry.
- Returns the `data` object.
  - `status: "invested"` means done; LO-05 has already set the audit to `invested`, so don't overwrite it.
  - Anything else (`dry_run`, `partial`, `failed`) comes with `error: {code, message}` and leaves the audit `computed`.
- `pending_carry`: LO-05 subtracts what it invested (never below 0). This works whether LO-04 zeroes `pending_carry` itself or leaves it for LO-05. If LO-04 zeroes it and the invest then fails, the money lives only in the still-`computed` audit; decide in LO-04 whether next week re-invests that audit or re-carries it, so it isn't counted twice.

## LO-06 Order Reconcile
Triggers: Schedule `0 6-14 * * 1-5` (hourly Mon–Fri 06:00–14:00 Vancouver, so 45 runs a week; outside market hours nothing changes, spec R3) and `POST /lo/reconcile/run {user_id?}`.
1. Read all orders, keep the non-terminal ones (terminal = `filled`, `canceled`, `expired`, `rejected`, `replaced`). If there are none, reply without calling Alpaca.
2. Account check, as in LO-05: if Alpaca isn't usable, reply `UPSTREAM_ERROR` and change nothing. No throw, so an hourly schedule doesn't spam LO-09.
3. `GET /v2/orders:by_client_order_id` per order → update `alpaca_order_id`, `status`, `filled_qty`, `filled_avg_price`, `submitted_at`, `filled_at`, only when something changed.
4. Newly `rejected` → one retry as `{client_order_id}-r1` with the same amounts, stored as a new row. If that retry can't be placed, is rejected on submit, or is later rejected itself, the last node throws *after* the webhook reply, so LO-09 alerts (once Z sets the error workflow).
5. A 404 (e.g. another lane's made-up order) counts as `failed` and is listed in `problems`; the row is untouched.

The schedule is live now because publishing the webhook also publishes the schedule. It's harmless: with no credential and no open orders it does nothing. Z can disable the node if wanted.

## How to test
`test-b` fixtures are in the tables: user `test-b` (active, consent, `pending_carry` 30), a balanced/global profile, and audit `test-b-2026-11-09` (`computed`, investable 26.15). Never `maya`.
```bash
npm test
```
```bash
node scripts/n8n.mjs call POST lo/invest/run '{"audit_id":"test-b-2026-11-09","user_id":"test-b","investable_cad":26.15,"dry_run":true}'
```
```bash
node scripts/n8n.mjs call POST lo/invest/run '{"audit_id":"test-b-2026-11-09","user_id":"test-b","investable_cad":26.15}'
```
```bash
node scripts/n8n.mjs call POST lo/reconcile/run '{"user_id":"test-b"}'
```
Expected today:
- the dry run → 200 with VTI 9.41 / VXUS 5.49 / BND 11.25 CAD and EWC folded;
- the real run → 502 `UPSTREAM_ERROR`, "credential is missing";
- reconcile → 200 `checked: 0` (no open test-b orders).

### What was proven (2026-11-14, against the running n8n)
- **Dry run** via webhook and via Execute Workflow: Frankfurter 1.4258, split as in the fixtures. At the fixtures' rate (1.3810) USD is 6.81 / 3.98 / 8.15 = 18.94, identical to `portfolio.json`.
- **FX fallback inside n8n**: the same Frankfurter node pointed at a failing route outputs `{error}`, and the plan uses config `fx_fallback_usdcad` 1.38.
- **Missing credential**: LO-05 → 502 `UPSTREAM_ERROR` + split, 0 order rows, audit `computed`, `pending_carry` unchanged. LO-06 → 502 with `open: 2` and nothing changed (while test orders existed).
- **Validation**: 400 (missing `audit_id`, over the cap, `audit_id` of another user), 404 (unknown user, unknown audit).
- **Writes**, using copies of the LO-05/LO-06 Data Table nodes fed by the lib with simulated Alpaca answers on `test-b`:
  - order upsert (with null `filled_at`, nanosecond timestamps normalized);
  - audit → `invested`, `pending_carry` 30 → 3.85;
  - reconcile fill (VTI), reject (VXUS) → `-r1` row.
  - Then a real `/lo/invest/run` on the invested audit returned the 4 stored orders with `already_invested: true` and placed nothing.
- That testing used a dev-only workflow `DEV-B Lane B fixtures (delete me)` (`leftoverDEVBfixt`), now **unpublished and archived**. The n8n CLI can't delete workflows, so delete it in the UI (Workflows → Archived). Its JSON isn't in the repo.

## Blocked on the `Alpaca Paper` credential: check once it exists
1. **Create it**: type Custom Auth (`httpCustomAuth`), name `Alpaca Paper`, JSON `{"headers":{"APCA-API-KEY-ID":"…","APCA-API-SECRET-KEY":"…"}}`, paper keys only.
2. **Attach it**. n8n refuses to publish *or run* a workflow whose nodes reference a credential that doesn't exist, so the 7 `Alpaca: …` HTTP nodes ship with no credential block. Once the credential exists, run this, push both files, and commit:
   ```bash
   node -e 'const fs=require("fs");const id=process.argv[1];for(const f of process.argv.slice(2)){const w=JSON.parse(fs.readFileSync(f,"utf8"));for(const x of w.nodes)if(x.type==="n8n-nodes-base.httpRequest"&&x.name.startsWith("Alpaca:"))x.credentials={httpCustomAuth:{id,name:"Alpaca Paper"}};fs.writeFileSync(f,JSON.stringify(w,null,2)+"\n")}' leftoverCredAlpc n8n/workflows/05-invest-executor.json n8n/workflows/06-order-reconcile.json
   ```
   Any id works: import re-links by name and type. A fixed id (`leftoverCredAlpc`, created with `n8n import:credentials` like `leftoverCredHook`) keeps the files stable. Lane E's positions call needs the same credential.
3. **Fractionable**: `GET /v2/assets/VTI` (then VXUS, EWC, BND, SGOV) → `tradable: true`, `fractionable: true`, `status: "active"`. If one isn't fractionable, propose a substitute to Sergio (config `sleeve_symbols`, owned by P0). I couldn't check this: the assets endpoint needs the keys.
4. **Minimum notional**: Alpaca's docs say "as little as $1"; the code uses `MIN_NOTIONAL_USD = 1` in `lib/allocate.mjs`. Confirm a $1.00 notional order is accepted; if Alpaca now wants more, change that constant and re-paste.
5. **First real run**: `POST /lo/invest/run` for `test-b-2026-11-09` → `status: "invested"`, 3 orders `accepted` in the Alpaca paper dashboard (a weekend gives `accepted`/queued, spec §12), `orders` rows written, audit `invested`, `pending_carry` 30 → 3.85.
6. **Duplicate `client_order_id`**: put the audit back to `computed` and remove the test-b `orders` rows (DEV-B's `reset` did that; recreate it, or do the two updates by hand in the UI), then call again. Expect `duplicate: true` on every order and **no** new orders in the dashboard. Note Alpaca's actual answer to the second POST (believed to be 422 "client_order_id must be unique") in this file. The code doesn't depend on the text.
7. **Reconcile a real order**: Monday after 06:30 Vancouver, `POST /lo/reconcile/run {"user_id":"test-b"}` → `updated: 3`, rows `filled` with `filled_qty`, `filled_avg_price`, `filled_at`. On the weekend, `checked: 3, updated: 0` is correct.
8. **Retry path** (`-r1`) and the LO-09 alert after a second rejection: only testable with a real rejection. Unit tests cover the decisions.
9. If fractional orders behave oddly, reset the paper account (Alpaca docs suggest it).

## Proposed changes for Sergio (spec / contracts / config; not made here)
- **`contracts/webhooks.md`, LO-05 response.** These are additions; nothing existing changes:
  - `data.status` can also be `partial`;
  - `fx_source` can also be `previous_run` (a re-run reusing the stored rate, and the already-invested reply);
  - orders can have `status: "failed"` + `error`;
  - new fields `folded[]`, `allocation_source` (`profile` | `tier`), `already_invested`, `warnings[]`;
  - internal callers get `error` on the data object when nothing was invested.
- **`contracts/webhooks.md`, LO-06.** `POST /lo/reconcile/run` accepts an optional `{user_id}` (testing). The reply can carry `problems[]`, `alerts[]`, and on `UPSTREAM_ERROR`, `open`.
- **Spec §10 WF05 step 3**: say the $1 minimum is in **USD**. The fixtures already imply it.
- **Spec §10 WF06**: record the schedule as hourly Mon–Fri **06:00–14:00 Vancouver**, not round the clock (R3).
- **Config `fx_fallback_usdcad`**: the seed has 1.38; Frankfurter says 1.4258 today. Suggest about 1.42.
- **`n8n/ids.json`**: add `alpaca_paper: "leftoverCredAlpc"` if the credential is created with that fixed id.
