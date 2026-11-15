# Leftover: status and next steps

*Updated 2026-11-15. `spec.md` is still the source of truth; this page is the handoff: what exists, what was done, what's left.*

**Repo:** https://github.com/danieldalopez/leftover (private) · **Dashboard:** https://leftover-rosy.vercel.app

## Where things stand
- **Public dashboard:** https://leftover-rosy.vercel.app. It shows "Live from n8n" while this Mac runs n8n and the tunnel (preview servers `leftover-n8n` + `leftover-public`). Otherwise it shows its built-in sample data with a "Mock data" badge.
- **Backend:** 11 n8n workflows (LO-00 … LO-09) on this Mac's n8n 2.47.7. They're all built and published, with no stubs left.
- **Checks:**
  - `npm test`: 194/194.
  - `node scripts/check-api.mjs`: passes.
  - `node scripts/demo-rehearsal.mjs --twice`: clean (with documented fallbacks).
  - A fresh, empty n8n set up from the repo passes the same checks.
- **Services:** working without keys. Alpaca, Plaid and Gmail each use their fallback until the keys exist (spec §19.5). There's no LLM by choice (D4).

## What was done
**Wave 1 (P0 foundation)**
- `spec.md` as the source of truth, `BUILD-PLAN.md` and `contracts/`.
- The seed (Maya, 43 transactions, expected audit results).
- LO-00 (tables + seed + reset) and LO-09 (error alerts).
- Stubs with fixed IDs, and the key-free push/test tooling in `scripts/n8n.mjs`.

**Wave 2 (six parallel lanes, all merged)**
- A: audit engine (LO-04).
- B: invest + reconcile (LO-05/06).
- C: bank sync + manual expense (LO-02/03/03b).
- D: onboarding form (LO-01).
- E: dashboard API + digest (LO-08/07).
- F: Next.js dashboard.

Each lane's notes are in `n8n/notes/A.md` … `F.md`.

**Wave 3 (integration)**
- **Reset backfills Maya's 3 past weeks.** Reset now audits them through LO-04, so History is never empty.
- **Error alerts work.** LO-09 is the error workflow everywhere, and it's published, because n8n 2.47 skips an unpublished one. Caught 500s still alert, and the Sunday 20:00 schedule is on.
- **One-command setup.** `scripts/setup-instance.mjs` sets up any n8n: the webhook credential, placeholder credentials and all 11 workflows in order. Alpaca and Plaid have fixed credential IDs, so pasting keys into one credential is enough.
- **Demo:** `demo/demo-script.md` and `scripts/demo-rehearsal.mjs`. The demo bar no longer says "orders placed" when nothing was invested.

**After Wave 3**
- **Public link, nothing installed** (`scripts/public-tunnel.mjs` + `scripts/vercel-live.mjs`):
  - a proxy exposes only `/webhook/*`, so the n8n editor stays private;
  - macOS's `ssh` tunnels it to localhost.run;
  - Vercel is re-pointed automatically whenever the free address rotates.
- **Timezone fix:** BC has been on UTC−7 all year since 2026-11-01, but Node's built-in timezone data (2026a) didn't know it. Newer ICU data (tz 2026e) from the Mac's own Homebrew ICU is in `n8n/icu-tz/`, with a `node` wrapper on n8n's `PATH`. Both dashboards now agree the audit runs Sunday 8:00 pm.
- **Decisions recorded** (spec §18):
  - D4: no LLM, template text;
  - D6: the leftover is capped at the budget when a refund exceeds the week's spend;
  - D7: Plaid `OTHER` counts as spending;
  - D8: backfilled weeks stay "not invested";
  - D9: the fallback FX rate is 1.42.
- **Spec fixes from the lanes:**
  - loan payouts are excluded;
  - the $1 minimum is in USD;
  - order checks run hourly, weekdays only;
  - audit finality and carries are clarified.
- **Cleanup:** the unused `LLM` credential was removed from n8n (backup: `~/.n8n/database.sqlite.bak-2026-11-15-before-llm-cred-delete`), and the six lane sessions were archived.

## Next steps
**Needs Sergio (in this order)**
1. **Create the n8n owner account** at http://localhost:5678. It's needed to show the workflow canvas, the judged part.
2. **To do: record the backup video** of one full run. Not made yet; spec §15 asks for it in case anything fails live.
   - [ ] Start `leftover-n8n` and `leftover-public`, then run `node scripts/demo-rehearsal.mjs` so Maya starts clean.
   - [ ] Press Cmd+Shift+5 → "Record Selected Portion", then follow `demo/demo-script.md`: onboarding form, This week, add the $14 purchase, Run audit now (with the n8n canvas), Send digest. About 5 minutes.
   - [ ] Save it in `demo/` (or a shared drive if it's too big for git) and note where it is here.
   - Fallback: Claude can build a captioned screenshot video of the dashboard steps with ffmpeg (no mouse or n8n canvas).
3. **Demo day:**
   - start `leftover-n8n` and `leftover-public` (the app stops them between sessions);
   - run `node scripts/demo-rehearsal.mjs` (it ends with a reset);
   - present.

**Optional (makes steps real instead of fallbacks)**

4. **Alpaca paper keys** → n8n credential `Alpaca Paper`: `{"headers":{"APCA-API-KEY-ID":"…","APCA-API-SECRET-KEY":"…"}}`. Then check the items in `n8n/notes/B.md` "Blocked on the Alpaca Paper credential", including that all 5 symbols are fractionable.
5. **Plaid sandbox keys** → `Plaid Sandbox`: `{"body":{"client_id":"…","secret":"…"}}`. Then check `n8n/notes/C.md` "Untested until the Plaid keys exist", for example whether Plaid categorizes the $14 Banh Mi as eating out.
6. **Gmail.** Self-hosted n8n needs your own Google Cloud OAuth client (see `n8n/README.md` §3). Then turn on LO-07 "Digest: send email" and LO-09 "Send alert email", and set config `demo_email_to`.

**Known limits**
- **The live link depends on this Mac:** n8n and the tunnel must be running. The free tunnel address rotates; the dashboard shows sample data for about a minute while Vercel redeploys.
- **The demo bar is public:** anyone with the link can press it, Reset included, so share the link only with judges.
- **The Sunday 20:00 schedule audits every active user**, including the lanes' test users `test-a` … `test-f`. Reset before presenting.
- **Untested paths:** n8n Cloud (UI import gives new workflow IDs; see `n8n/README.md` §6), and real Plaid and Alpaca calls (only their fallbacks and mocks are proven).
- **After a future timezone release:** `brew upgrade icu4c && node scripts/update-icu-tz.mjs`.

## Where to look
| What | File |
|---|---|
| Rules, decisions, contracts | `spec.md` (§18 decisions, §19 locked conventions), `contracts/` |
| Set up / run n8n, credentials, going public | `n8n/README.md`, `n8n/CONVENTIONS.md` |
| Presenting | `demo/demo-script.md`, `scripts/demo-rehearsal.mjs` |
| Per-workflow details and open checks | `n8n/notes/A.md` … `F.md` |
| Timezone data | `n8n/icu-tz/README.md` |
