# Lane C notes: bank data (LO-03b, LO-02, LO-03)

Built 2026-11-14 on n8n 2.47.7. Everything below was run on the shared local n8n under `test-c`.

## What's here
| File | What |
|---|---|
| `n8n/workflows/03b-manual-expense.json` | **LO-03b** `leftoverWF03bexp`: n8n Form "Log a purchase" + `POST /lo/expense` |
| `n8n/workflows/02-plaid-connect-sandbox.json` | **LO-02** `leftoverWF02plad`: `POST /lo/plaid/connect-sandbox` |
| `n8n/workflows/03-transaction-sync.json` | **LO-03** `leftoverWF03sync`: every 6 h + `POST /lo/sync` + `POST /lo/demo/add-txn` + called by LO-02 |
| `lib/categorize.mjs` | PFC → `category_key`, sync pages → rows, pending → posted, removals, manual-expense validation, add-txn validation, Plaid error parsing, LO-03 reply |
| `lib/categorize.test.mjs` | 39 tests, incl. a check that every Lane C Code node embeds the current lib verbatim |
| `lib/categorize.sample-sync.json` | Realistic `/transactions/sync` pages (PFC v2): 2-page first sync, pending → posted, correction, reversal, `NOT_READY`, incomplete run |

All three are published (active). Code nodes paste `lib/week.mjs` and `lib/categorize.mjs` verbatim (§19.6); the drift test fails if they diverge.

## How to test

```bash
npm test                                   # 59 tests, all green
node scripts/n8n.mjs call POST lo/expense '{"user_id":"test-c","amount_cad":14,"category_key":"eating_out","merchant":"Banh Mi Saigon"}'
node scripts/n8n.mjs call POST lo/sync '{}'          # 200 {users:0,…} until someone links a bank
```

**LO-03b form:** open `http://localhost:5678/form/lo-log-purchase` in a normal browser. The User field defaults to `maya` (the demo user); type `test-c` for testing. (The Claude app's built-in browser pane blocks the form's POST with `ERR_BLOCKED_BY_CLIENT`, so use a real browser. The same multipart POST via curl works.)

**`test-c` needs budgets** for LO-03b (it validates the category against the user's active budgets, and returns 404 if the user has none). The temporary workflow `ZZ Lane C test fixtures` creates them (see Harness).

### Proven (commands + results)
- **LO-03b API:** 200 writes a `source:"manual"` row (date defaults to today in Vancouver; a negative amount is a refund; category key *or* label accepted). 400 for bad user_id / amount 0 / future date / category not in budgets; 404 for a user with no budgets.
- **LO-03b form:** submit → the form calls LO-03b itself through its Execute Workflow Trigger (one copy of the checks) → completion page "Purchase logged: $7.25 at Compass Card on 2026-11-14, counted in Transport…" with the disclaimer, or "That purchase was not logged" with the reason. Row written, executions finish.
- **LO-02 / LO-03 against a mock Plaid** (the real workflow JSON; only the Plaid host, webhook paths and the sub-workflow ID differ, see Harness). Full transcript: `last-run.txt` in the session notes folder.
  - connect → `/sandbox/public_token/create` (ins_109508, `user_transactions_dynamic`) → exchange → `bank_links` row → LO-03 → `{added:12, modified:1}`. The mock answered `NOT_READY` first; LO-03 re-asked 1.5 s later, then paged `'' → c4 → c8 → c12`; the cursor `c13` was saved only at the end.
  - The `Plaid Sandbox` Custom Auth credential **does** inject `client_id` + `secret` into every JSON body, paginated requests included (the mock logged them).
  - `add-txn` → create → refresh → wait 5 s → sync → `{added:2, modified:1, removed:2}`: the posted coffee carries `pending_txn_id`, its pending row is `removed = 1`, the grocery correction updated in place, the reversal marked removed. No duplicate `txn_id`s.
  - Connecting again → `already_linked: true`, no second Item (so a double click can't double every transaction).
  - Plaid error mid-pagination (`TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`) → 502 `UPSTREAM_ERROR`, nothing written, cursor unchanged; the next sync recovers. Errors on create / exchange / sandbox create → 502 with Plaid's code + message; a failed connect writes no `bank_links` row.
  - Validation: 400 bad user_id, 404 no bank link / unknown user.
- **Real routes, up to Plaid:** `/lo/sync` (200 no links, 404 for test-c), `/lo/demo/add-txn` (404 no link), `/lo/plaid/connect-sandbox` (404 unknown user). With the placeholder credential, connect really calls sandbox.plaid.com and returns `502 "Plaid said INVALID_FIELD: client_id must be a properly formatted, non-empty string"`, so the live request path and Plaid's real error shape are both handled.

## Credentials
- **`Plaid Sandbox`** (Custom Auth), **created** with fixed ID `leftoverCredPlad` and placeholder values. **Sergio: open it in n8n and replace the JSON with your sandbox keys:**
  `{"body":{"client_id":"<sandbox client_id>","secret":"<sandbox secret>"}}`
  The workflows reference it by ID + name, so nothing needs re-linking. Not in `n8n/ids.json` yet (P0 file): please add `"plaid_sandbox": "leftoverCredPlad"`. On a fresh instance, create it with that ID (`n8n import:credentials`) or re-select it on the 5 Plaid HTTP nodes.
- `LO Webhook Key` on every webhook (as P0 set up).

## Design decisions worth knowing
- **Transaction date = `authorized_date`, else `date`** (Plaid: posted date). The purchase lands in the week it was made; a charge that posts days later is what LO-04's true-up (§6.6) re-audits. The spec doesn't say which date to use: please confirm.
- **Pending → posted:** the posted row stores `pending_txn_id`; the pending row is marked `removed` (Plaid lists it in `removed`, and LO-03 also marks it itself when it sees the posted row). `countableTransactions()` in the lib implements the contract's "what counts" rule if Lane A wants it.
- **Removed rows are never deleted:** LO-03 reads the user's stored Plaid rows and upserts a full copy with `removed = true` (one write operation; never a half-empty row).
- **Cursor:** saved only when the run ends with `has_more = false`. If a run stops early or Plaid errors, the old cursor stays, so the next run restarts the whole update (Plaid's rule).
- **PFC v2:** requested explicitly (`options.personal_finance_category_version: "v2"`); accounts enabled after 2025-12-03 only get v2 anyway.
- **Sandbox only:** `plaid_base_url` from `config` must be exactly `https://sandbox.plaid.com` or the workflow refuses (500 INTERNAL).
- **One bank link per user:** connect is idempotent (`already_linked: true`). To relink, delete the user's `bank_links` row.
- **`access_token` is stored in `bank_links`** (sandbox only; spec §9 flags this as a production risk).
- **Schedule:** LO-03 runs every 6 h for all links. If any link fails on a scheduled run, the run throws, so LO-09 alerts once Z sets the error workflow.
- The LO-03b form has no auth and identifies the user by a "User" field (default `maya`). Fine for a demo; say so if asked.

## Untested until the Plaid keys exist
1. Real Plaid accepting our bodies with real keys: `/sandbox/public_token/create` (with `options.transactions.days_requested: 90`), `/item/public_token/exchange`, `/transactions/sync` (`count: 500`, PFC v2), `/sandbox/transactions/create`, `/transactions/refresh`.
2. **How long a new sandbox Item stays `NOT_READY`.** LO-03 re-asks every 1.5 s, up to 40 requests (~60 s). If it's still not ready, connect returns `sync.not_ready: true` and a later `/lo/sync` picks the data up.
3. **Which PFC Plaid assigns to a custom `/sandbox/transactions/create` purchase** ("Banh Mi Saigon"). If Plaid leaves it uncategorised it lands in `other`, not `eating_out`: check this before the demo.
4. Whether a custom transaction shows up within the 5 s wait. If not, add-txn answers `added: 0` and the next `/lo/sync` brings it in; raise the Wait if so.
5. `user_transactions_dynamic` adds random pending transactions and posts old ones **on every `/transactions/refresh`**, so each add-txn may bring extra transactions besides the one you created. For Maya's demo, Z should decide whether that noise is acceptable.
6. Sandbox amounts are USD (First Platypus Bank). They are stored as CAD 1:1 (demo simplification, not converted).
7. Real Plaid error bodies on a paginated sync (the mock reproduces n8n's error shape; `plaidError()` handles both shapes seen).

## Needs Sergio (spec / contract / P0 files: I did not edit them)
1. **`category_map` seed: add `LOAN_DISBURSEMENTS | "" | excluded | true`.** It's a new PFC v2 primary (plaid.com/documents/pfc-taxonomy-all.csv). Without a row it falls back to `other`, and loan money (a negative amount) then looks like a refund: in the harness a $500 disbursement pushed test-c's `other` spend to −$463, which would inflate the surplus. A unit test pins this gap (`every PFC v2 primary resolves`), and will need updating when the row lands.
   Also decide `OTHER` (v2's `OTHER_OTHER`, which maps to v1's "other transfer"): it currently falls back to `other` as the spec says. Leave it or exclude it?
2. **`n8n/ids.json`:** add the credential ID `leftoverCredPlad` (and mark `Plaid Sandbox` as "created, paste keys" in CONVENTIONS).
3. **`contracts/webhooks.md`:** additive response fields I return: `already_linked: true` (connect, second press), `sync.not_ready: true` (Plaid hadn't pulled the Item yet), `sync.error` (connect worked but the first sync failed). Add them, or tell me to drop them.
4. **Spec §6.3 / data-tables:** state that `transactions.date` = Plaid `authorized_date` when present, else `date`.
5. Optional: let me add the Lane C generators + mock Plaid harness to the repo (e.g. `scripts/lane-c/`), so Z can rerun them. For now they live in the session notes folder (`lane-c-harness/`).

## Harness (temporary, outside the repo)
In the session notes folder `…/side-session-notes/local_34b9010c-…/lane-c-harness/`:
- `mock-plaid.mjs`: mock Plaid sandbox on `127.0.0.1:8787` that replays `lib/categorize.sample-sync.json` (4 updates per page, `NOT_READY` on an Item's first sync, refresh releases run 2, fail switches).
- `gen-harness.mjs`: copies the real LO-02/LO-03 JSON into `leftoverTSTc02pl` / `leftoverTSTc03sy` (paths `lo-test-c/…`, Plaid host → mock, schedule disabled). `gen-fixtures.mjs`: `leftoverTSTfixc`, `POST /lo-test-c/fixtures` resets test-c (user + 7 budgets; wipes test-c transactions and bank_links; every delete is hard-coded to test-c).
- `run-harness.sh`: the full scenario; ends by resetting test-c, so no mock bank link is left for the real schedule to try against real Plaid.
- `gen-02/03/03b.mjs`: the generators for the committed workflow JSON (they embed the lib). `exec.mjs`: read-only dump of an execution's node outputs.
- Scripts point at this worktree path (`REPO` in `gen-common.mjs`); edit it if the worktree is gone.

The three `ZZ Lane C …` workflows are in n8n, **unpublished**. The n8n CLI can't delete workflows, so delete them in the UI (or publish them again to rerun the harness). One old form execution (#84) sits in `waiting` forever (its resume URL was lost while testing); harmless, delete it in the UI if you like. The form ending now has a 10-minute wait limit, so this can't recur.

## Verified node shapes (for P0/Z to add to `n8n/templates/node-snippets.json`)
All executed on this n8n: If 2.2 (boolean condition, filter version 2), Switch 3.2 in expression mode (`numberOutputs` + `output`), HTTP Request 4.5 with Custom Auth + JSON body + body-cursor pagination + `continueErrorOutput`, Respond to Webhook 1.5 with an expression `responseCode`, Form Trigger 2.6 + Form 2.5 ending (wait limit), Execute Workflow 1.2 calling a passthrough trigger (including itself), Loop Over Items (splitInBatches 3), Wait 1.1 (version read from the installed package), Data Table upsert and update with an `eq` filter.

**Gotchas found:**
- A Respond to Webhook node anywhere downstream of a Form Trigger stops the form (`not supported in workflows initiated by the n8n Form Trigger`). LO-03b's form calls its own workflow instead.
- `executeOnce: true` on a Code node truncates `$input.all()` to the first item.
- Data Table insert/upsert rejects unknown keys (`unknown column name`).
- With pagination on, an HTTP error item carries the body in `error.error`, not in `error.message`.
