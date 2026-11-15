# Lane F: Dashboard (Next.js)

Status 2026-11-14: all five pages render from fixtures (`MOCK=1`) and from live n8n; `npm run build` passes. Not deployed (Wave 3 does Vercel).

## What it is
- `dashboard/`: Next.js 16.4 (App Router), React 19, TypeScript 7, plain CSS. No other dependencies.
- Pages: `/` This week, `/history`, `/portfolio`, `/compounding`, `/settings`. The spec §13 disclaimer is in the footer of every page (`lib/constants.ts`). The demo control bar shows when `summary.demo_mode` is true.
- n8n is only called from the server (`lib/n8n.ts`), so `N8N_WEBHOOK_KEY` never reaches the browser:
  - pages are server components that call LO-08 on each request (page load);
  - `POST /api/demo/<action>`: demo bar. Only an allow-list of n8n routes; the server builds each body;
  - `POST /api/settings`: proxies to `POST /lo/api/settings` with `DEMO_USER_ID`;
  - `GET /api/data/<summary|audits|portfolio|projection|settings>`: the same data the pages use, for debugging and `npm run smoke`.
- **No polling.** Data loads on page load, and once more after a button press (`router.refresh()`). The layout and the page share one summary call per request (React `cache`). Settings has no GET in the contract, so the page reads it with `POST /lo/api/settings {user_id}` (no fields = no change).

## Run it
```bash
cd dashboard && npm install
npm run dev:mock                         # fixtures only, never calls n8n
npm run dev                              # live n8n
npm run build
npm run smoke -- http://localhost:3000   # per endpoint: LIVE or MOCK (reason); checks the disclaimer on each page
```
Env vars, all server-side (never `NEXT_PUBLIC_`): `MOCK`, `N8N_BASE_URL`, `N8N_WEBHOOK_KEY`, `DEMO_USER_ID` (default `maya`). Lookup order: process env / `dashboard/.env.local`, then the repo's `.env`, then the main checkout's `.env` when running in a lane worktree (same rule as `scripts/n8n.mjs`). Template: `dashboard/.env.example`.

## Mock data and fallback
- `dashboard/mocks/` is a copy of `contracts/fixtures/` (Vercel only sees `dashboard/`). Refresh it with `npm run mocks`; `prebuild` also refreshes it when `../contracts` exists, and keeps the committed copy when it doesn't.
- `MOCK=1`: every page serves fixtures. Demo buttons and Settings → Save answer "Mock mode: would POST …" and call nothing.
- Live mode falls back to the fixture, with an amber **"Mock data · <reason>"** badge (hover shows the detail), when n8n answers `{ok:true, stub:true}`, returns an error envelope / 403 / 404, misses a contract key, or can't be reached. A green "Live from n8n" badge means the numbers are real.
- Portfolio in mock mode: `?fixture=queued` shows `portfolio-queued.json` (Sunday night, before Monday's open).

## Spec §12: queued orders
- Chip: **"Queued · fills at {weekday of `next_open`}'s open"**, plus "est. US$x" from `estimated_value_usd`. The page also shows a banner ("N orders queued … This is expected, not an error").
- Live LO-08 sends `market_open: null, next_open: null` while Alpaca isn't connected. The page then says "market hours unavailable (Alpaca not connected)" and "fills at the next open".

## Demo bar
- Buttons hit the routes in `contracts/webhooks.md` for `DEMO_USER_ID`: Connect sandbox bank, Add sandbox purchase (Banh Mi Saigon, $14, spec §15), Sync now, Run audit now, Send digest, Reset demo.
- Add sandbox purchase: if LO-03 is a stub or fails, the result offers **"Log it as a manual expense instead"** (`POST /lo/expense`, `eating_out`), which is the §15 backup. It isn't automatic, so a half-done add-txn can't create a duplicate.
- Reset asks for confirmation, and the server refuses it unless `DEMO_USER_ID` is `maya` (reset only reseeds maya).
- Each result shows a one-line summary plus the raw n8n response under "Response".

## Tested
- **Mock:** all five pages at desktop (800 px) and phone (375 px), in light and dark. No horizontal page scroll. Also checked: History tooltip and category filter, the Compounding 4/6/8% toggle (no network call), Settings validation and save.
- **Live, `maya`, read-only:** LO-08 is live; the smoke test shows all five endpoints LIVE and every page renders. Portfolio and Compounding are empty states because there's no invested audit yet (no Alpaca credential; Lane A keeps backfilled weeks `computed`).
- **Live, `DEMO_USER_ID=test-f`:** every demo action through `/api/demo/*`:
  - LO-02, LO-03 and LO-07 are reported as stubs;
  - LO-04's webhook was unregistered at that moment, and the error was shown;
  - manual expense returned `NOT_FOUND` (test-f has no budgets);
  - reset was refused by the guard;
  - an unknown action gets 404.

  test-f's reads fall back to mock with an "API error" badge. No button was pressed against `maya`.
- Local preview configs (worktree-only `.claude/launch.json`, not committed): `leftover-dash-mock` :3210, `leftover-dash-live` :3211 (maya), `leftover-dash-live-testf` :3212.

## Left for Z / known gaps
- **Vercel** (Wave 3): set the root directory to `dashboard`. A mock preview needs `MOCK=1`. Live needs `N8N_BASE_URL` (public n8n URL), `N8N_WEBHOOK_KEY` and `DEMO_USER_ID=maya`. `/api/demo/*` sets `maxDuration = 120` for the audit chain.
- The demo bar is open to anyone with the deployed URL (Reset, Run audit). That's fine for the hackathon; use Vercel password protection if needed.
- The demo bar hasn't run end to end against real workflows (they're stubs, and there are no credentials). Run the spec §15 script once A, B, C and E are merged.
- "Retake the investor quiz" opens `settings.onboarding_url` as is. Lane D's form can prefill with `?email=&name=`, but no API returns the user's email, so there's no prefill.
- The fixtures show backfilled weeks as `invested`, but Lane A keeps them `computed`. History shows those weeks as "$x not invested", and the Invested series is 0 for them.
