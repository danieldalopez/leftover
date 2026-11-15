# Lane A: Audit engine (LO-04)

Owns `n8n/workflows/04-weekly-audit.json` (`leftoverWF04audt`), `lib/audit.mjs`, `lib/audit.test.mjs`, this file.
Status 2026-11-14: done, live on the local n8n, BUILD-PLAN "Done when" passes. No credentials needed.

## What it does
`POST /lo/audit/run {user_id?, week_start?, invest?}` (+ a Sunday 20:00 schedule, **disabled for now**, see below):

```
Webhook ─┐                                                                           ┌─ Respond error (400/404)
Schedule ┴─ Normalize request ─ Get users ─ Get budgets ─ Get transactions ─ Get audits ─ Compute audits ─ Bad request? ─┤
                                                                                     ├─ Audits to write ─ Upsert audit ─ User updates ─ Update user
                                                                                     ├─ Invest jobs ─ Run LO-05
                                                                                     ├─ Digest jobs ─ Run LO-07
                                                                                     └─ Build response ─ Respond OK
```
- All math is one Code node, **Compute audits**: `lib/week.mjs` + `lib/audit.mjs` pasted verbatim between marker comments, then ~15 lines of glue. It runs `auditSelfTest()` (spec §6.8 worked example) first and throws if it's wrong.
- The four branches after **Bad request?** run **top to bottom** (n8n v1 order): rows are written before LO-05 is called, LO-05 answers before LO-07, and the response is built last. Keep that vertical order if you move nodes (a sticky note says so).
- Money is integer cents inside `lib/audit.mjs`, dollars in tables and responses.
- Transactions and audits are fetched from `since` = last week's Monday (or earlier) on, which the §6.6 true-up needs. Users and budgets are fetched whole and filtered in code (fine at hackathon size).

## Rules as implemented (spec §6, §10 WF04)
- **What counts:** not removed, a budget category (so `excluded` and inactive budgets drop out), date in the week, not superseded. A pending row is superseded when any non-removed row anywhere (not only that week) has `pending_txn_id` = its `txn_id`.
- **Under/over** per category, no netting. A refund bigger than the week's spend gives a negative `actual` and `under > planned` (spec as written; see "Spec questions").
- **Cushion:** absorb overspend first (if `absorb_overspend`), then `min(round(gross × rate), target − buffer)`. Half cents round toward the buffer. A buffer above target is kept, never released.
- **Late-posting true-up:** re-audit last week's audit (its own `planned` amounts from `lines_json`) with today's transactions; `late_adj = max(old gross − new gross, 0)`. A `skipped_paused` last week has nothing to true up.
- **Investable:** `gross − to_buffer − late_adj − deficit_carry + pending_carry`; a negative result becomes the new `deficit_carry`; cap `max_weekly_invest` (the excess is not carried); below `min_invest` → `status: carried`, `investable_cad: 0`, `pending_carry_after` = the amount.
- **Carries are owned by LO-04.** When it invests, the old `pending_carry` is inside `investable_cad`, so LO-04 writes `users.pending_carry = 0` before calling LO-05. LO-05 must not subtract it again (told Lane B; see "Spec questions").
- **Paused user:** `skipped_paused` row with the lines, `gross_surplus` and `total_over` for information; `to_buffer` / `investable_cad` 0; balances untouched; no LO-05, no LO-07.
- **Idempotency:** audits are written once. A rerun of a week that already has a `computed`, `carried` or `invested` audit writes nothing and returns the stored row. If it's `computed` and the run invests, LO-05 is retried with the stored amount (a backfilled week, or a failed invest). A `skipped_paused` row is recomputed (it moved no money). Later changes to an audited week reach the next week through `late_adj`.
  - Why not recompute: the audits table has no "balance before" columns, so a recompute can't undo the first run's effect on the user's buffer and carries.
- **Order guard:** a single-user request for a week older than that user's newest money-moving audit gets `400` ("audit weeks in order"); in an all-users run that user is skipped.
- **`invest: false`** (backfill): writes the audit and balances as usual, never calls LO-05 or LO-07. The week stays `computed` with its would-be `investable_cad` and is not carried.
- **LO-07** is called for every newly written audit of an investing run (`computed`, `invested` or `carried`), after LO-05. Not for backfills, reruns or paused users.
- LO-05 / LO-07 errors don't fail the audit (`onError: continueRegularOutput`); the audit then stays `computed`.
- Lane B confirmed LO-05 matches (its `n8n/notes/B.md`): it needs the audit `computed`, the user active with `consent_at`, and the amount within [`min_invest`, `max_weekly_invest`]. It returns its data object: `status: "invested"` (it set the audit itself; `already_invested: true` on a repeat), or `dry_run` / `partial` / `failed` with `error {code, message}`, leaving the audit `computed`. It writes `max(pending_carry − invested, 0)`, a no-op after LO-04 zeroes the carry.
- Default run (no `user_id`): every user with status `active` or `paused`, the current week. **Don't call it on the shared dev n8n**: it would audit every lane's test user.

## How to test
```bash
npm test                                   # lib/audit.test.mjs: §6.8 example, edge cases, Maya's seed, workflow/lib sync
node scripts/n8n.mjs push n8n/workflows/04-weekly-audit.json
node scripts/n8n.mjs call POST lo/demo/reset '{}'
# backfill Maya's 3 past weeks (matches demo/seed-data.json _expected and contracts/fixtures/audits.json)
for ws in 2026-10-19 2026-10-26 2026-11-02; do node scripts/n8n.mjs call POST lo/audit/run "{\"user_id\":\"maya\",\"week_start\":\"$ws\",\"invest\":false}"; done
node scripts/n8n.mjs call POST lo/audit/run '{"user_id":"maya"}'   # this week: invests via LO-05, then LO-07
node scripts/n8n.mjs call POST lo/audit/run '{"user_id":"maya"}'   # again: same answer, nothing written
```
(Dates are for the week of 2026-11-09; use the Mondays 1, 2 and 3 weeks before the current one.)

Results on 2026-11-14 (live):
- Backfill: 90.36 / 54.50 / 52.30 gross; to_buffer 45.18 / 27.25 / 26.15; buffer 45.18 → 27.25 → 41.00; investable = to_buffer each week. Exactly `_expected`.
- This week: gross 161.30, over 8.40, to_buffer 67.40, buffer 100, late_adj 0, investable 93.90. LO-05 received `{"audit_id":"maya-2026-11-09","user_id":"maya","investable_cad":93.9}`, LO-07 `{"user_id":"maya","audit_id":"maya-2026-11-09"}` (read from n8n's execution data).
- Rerun: identical response, no row changed, LO-05 retried (stub, still `computed`), no second digest.
- `test-a` (crafted with a temporary fixture route, since removed): below-minimum carry 3.50 then 6.50 invested; late posting `late_adj` 70 → `deficit_carry` 67; paused → `skipped_paused`, balances untouched; refund bigger than spend → actual −25, under 65; bad `week_start` → 400, unknown user → 404.
- To see an execution's node inputs without the UI: decode `execution_data.data` (n8n's "flatted" JSON) for the execution id in `execution_entity`.

## Changing the math
Edit `lib/audit.mjs` (or `lib/week.mjs`), run `npm test` (the last test fails: the Code node is out of date), then re-paste:
```bash
node --input-type=module -e "
import { readFileSync as r, writeFileSync as w } from 'node:fs';
const f = 'n8n/workflows/04-weekly-audit.json', wf = JSON.parse(r(f, 'utf8'));
const body = (p) => { const s = r(p, 'utf8'); return s.slice(0, s.lastIndexOf('\nexport {')).trimEnd(); };
const swap = (code, a, b, text) => { const i = code.indexOf(a) + a.length, j = code.indexOf(b, i); if (i < a.length || j < 0) throw new Error('marker ' + a); return code.slice(0, i) + text + code.slice(j); };
const node = (n) => wf.nodes.find((x) => x.name === n).parameters;
const c = node('Compute audits');
c.jsCode = swap(c.jsCode, '// ===== lib/week.mjs (verbatim) =====\n', '\n// ===== end lib/week.mjs =====', body('lib/week.mjs'));
c.jsCode = swap(c.jsCode, '// ===== lib/audit.mjs (verbatim) =====\n', '\n// ===== end lib/audit.mjs =====', body('lib/audit.mjs'));
const fn = body('lib/audit.mjs').match(/function readInvestResult\(result\) \{[\s\S]*?\n\}/)[0];
const b = node('Build response');
b.jsCode = swap(b.jsCode, '// from lib/audit.mjs (kept in sync by lib/audit.test.mjs)\n', '\n\nconst ran', fn);
w(f, JSON.stringify(wf, null, 2) + '\n');
"
npm test && node scripts/n8n.mjs push n8n/workflows/04-weekly-audit.json
```

## For Z (Wave 3)
- **Enable the schedule:** the `Sunday 20:00` trigger (cron `0 20 * * 0`, workflow timezone America/Vancouver) is in the file with `"disabled": true`, so the shared dev n8n doesn't audit every lane's test user and call LO-05 on Sunday night. Remove `disabled` once the real chain is wired.
- **Publish order matters on n8n 2.47:** a workflow whose Execute Workflow node points at an unpublished workflow can't be published ("Please publish all referenced sub-workflows first"). Import/publish LO-05 and LO-07 before LO-04 (and LO-03 before LO-02). It also means a push of LO-04 fails while Lane B or E is mid-push; just retry.
- **Backfill status:** `invest: false` leaves past weeks `computed`. `contracts/fixtures/audits.json` shows them `invested`, and WF08 sums `investable_cad` of `invested` audits for lifetime totals, so a pure backfill shows $0 lifetime invested. Either backfill with real paper orders (`invest: true`, oldest week first) or decide how History should show backfilled weeks.
- Rerunning a backfilled week with `invest: true` (the default) invests it via LO-05. Pass `invest: false` for backfills every time.
- Set `errorWorkflow: leftoverWF09errh` in settings (not set here).
- Node JSON verified here that `n8n/templates/node-snippets.json` doesn't have yet: Data Table `upsert` and `update` (filter + autoMap), If 2.2 string-equals, Execute Workflow 1.4 by id (`mode: each`, no `workflowInputs` for an "accept all data" trigger), Respond to Webhook 1.5 with an expression status code, Schedule 1.4 cron, Data Table `get` with a `gte` filter on a string date column.

## Spec questions (not changed; for Sergio)
1. **§10 WF05 step 6** says LO-05 "subtracts invested amount from pending_carry". With LO-04 already folding the carry into `investable_cad` and zeroing it, that would double-count. Suggest: "LO-04 owns `pending_carry` and `deficit_carry`; LO-05 doesn't change them."
2. **§10 WF04 step 6** says "upsert … if already invested, stop". Implemented as: audits are final once they move money (computed / carried / invested); a rerun only retries LO-05 for `computed`. Suggest wording it that way, since the audits table can't support a safe recompute (or add `buffer_before` / `pending_carry_before` / `deficit_carry_before` columns if recomputing is wanted).
3. **Refund bigger than the week's spend:** taken literally, `under` can exceed `planned` (shopping 40 / −25 → under 65). Cap it at `planned` instead? Lane E's `remaining_cad` uses the same formula, so change both or neither.
4. **Supersession** (`contracts/data-tables.md`): "no other row has pending_txn_id = this row's txn_id". Implemented as no other *non-removed* row, matching `scripts/seed.test.mjs`. Worth saying in the contract.
