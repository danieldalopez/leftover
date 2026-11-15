# Leftover: status and next steps

*Updated 2026-11-15. `spec.md` is still the source of truth; this page is the handoff: what exists, what was done, what's left.*

**Repo:** https://github.com/danieldalopez/leftover (private) · **Dashboard:** https://leftover-rosy.vercel.app

## Where things stand
- **Public dashboard:** https://leftover-rosy.vercel.app. It shows "Live from n8n" while this Mac runs n8n and the tunnel (preview servers `leftover-n8n` + `leftover-public`). Otherwise it shows its built-in sample data with a "Mock data" badge. **It still has the old look** until the redesign below is deployed (starting `leftover-public` redeploys it).
- **Demo video:** `demo/leftover-demo.mp4` (3 minutes, 720p, captions). It shows the onboarding form and the dashboard run with today's fallbacks (no Plaid, Alpaca or Gmail keys). It doesn't show the n8n canvas, which needs the owner login.
- **Backend:** 11 n8n workflows (LO-00 … LO-09) on this Mac's n8n 2.47.7. They're all built and published, with no stubs left.
- **Checks:**
  - `npm test`: 195/195.
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

**Final pass (2026-11-15)**
- **Dashboard redesign.** One blocky pixel theme (square corners, bevelled panels, a pixel typeface). Each page was cut down to what matters:
  - This week leads with the projected leftover, then spent and the cushion, then one line and one bar per category;
  - History, Portfolio and Compounding show three totals each, and their tables lost the secondary columns;
  - the header totals are gone, and the demo bar keeps the three demo steps in view with the rest under **More**.

  Everything spec §13 lists is still there.
- **Demo video** recorded by `demo/record-demo.mjs`, which drives the live form and dashboard in headless Chrome.
- **Bug fixed in LO-04:** the late-posting true-up ignored the refund cap (D6), so a late charge could go unnoticed in a week where another category had a net refund. There's a test for it.
- **FX fallback in LO-07/LO-08** is now 1.42 (D9; it was still 1.38), with the same 0.8–2.0 sanity range LO-05 uses.
- **Digest without Gmail** shows on the dashboard as "Digest built … (not sent)" instead of a red failure.
- **Leftovers of the build removed:** the stub builder and stub handling, the dev-only seed route in the LO-07/08 generator, five copies of the `.env` loader (now `scripts/env.mjs`), and lane and wave mentions in workflow notes, scripts and docs. LO-00, 01, 04, 07, 08 and 09 were pushed again.
- **`README.md`** added.

## Next steps
**Needs Sergio (in this order)**
1. **Create the n8n owner account** at http://localhost:5678. It's needed to show the workflow canvas, the judged part.
2. **Deploy the redesigned dashboard:** start `leftover-public` (it redeploys Vercel from `dashboard/`), then look at https://leftover-rosy.vercel.app.
3. **Optional: a screen recording with the n8n canvas.** The video in `demo/` covers the product but not the canvas. With the owner account created, record LO-04 running (Cmd+Shift+5) while pressing **Run audit now**.
4. **Demo day:**
   - start `leftover-n8n` and `leftover-public` (the app stops them between sessions);
   - run `node scripts/demo-rehearsal.mjs` (it ends with a reset);
   - present.

**Optional (makes steps real instead of fallbacks)**

5. **Alpaca paper keys** → n8n credential `Alpaca Paper`: `{"headers":{"APCA-API-KEY-ID":"…","APCA-API-SECRET-KEY":"…"}}`. Then check the items in `n8n/notes/B.md` "Blocked on the Alpaca Paper credential", including that all 5 symbols are fractionable.
6. **Plaid sandbox keys** → `Plaid Sandbox`: `{"body":{"client_id":"…","secret":"…"}}`. Then check `n8n/notes/C.md` "Untested until the Plaid keys exist", for example whether Plaid categorizes the $14 Banh Mi as eating out.
7. **Gmail.** Self-hosted n8n needs your own Google Cloud OAuth client (see `n8n/README.md` §3). Then turn on LO-07 "Digest: send email" and LO-09 "Send alert email", and set config `demo_email_to`.

After connecting any of these, re-record the video so it shows the real step: `npm i --no-save playwright-core && node demo/record-demo.mjs`.

**Known limits**
- **The live link depends on this Mac:** n8n and the tunnel must be running. The free tunnel address rotates; the dashboard shows sample data for about a minute while Vercel redeploys.
- **The demo bar is public:** anyone with the link can press it, Reset included, so share the link only with judges.
- **The Sunday 20:00 schedule audits every active user**, including the lanes' test users `test-a` … `test-f`. Reset before presenting.
- **Untested paths:** n8n Cloud (UI import gives new workflow IDs; see `n8n/README.md` §6), and real Plaid and Alpaca calls (only their fallbacks and mocks are proven).
- **After a future timezone release:** `brew upgrade icu4c && node scripts/update-icu-tz.mjs`.
- **`spec.md` still describes the LLM** in its architecture diagram and in §10 (WF01, WF07). D4 (§18) overrides those lines; they were left as written because spec changes need Sergio's approval.
- **Lane leftovers on this Mac:** four worktrees under `.claude/worktrees/` and six local `claude/lane-*` branches, all merged into `main`. Safe to remove.

## Where to look
| What | File |
|---|---|
| Rules, decisions, contracts | `spec.md` (§18 decisions, §19 locked conventions), `contracts/` |
| Set up / run n8n, credentials, going public | `n8n/README.md`, `n8n/CONVENTIONS.md` |
| Presenting | `demo/demo-script.md`, `scripts/demo-rehearsal.mjs`, `demo/leftover-demo.mp4` |
| Per-workflow details and open checks | `n8n/notes/A.md` … `F.md` |
| Timezone data | `n8n/icu-tz/README.md` |
