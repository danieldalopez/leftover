# Leftover

Hackathon project (Loop Hackathon, eProjects x n8n). n8n workflows are the backend and the judged deliverable; `dashboard/` is a Next.js front end that only calls n8n webhooks.

## Read in this order
0. `STATUS.md`: where things stand, what was done, next steps (the handoff page).
1. `spec.md`: **the single source of truth.** If code and spec disagree, the spec wins. Change the spec first (Sergio approves), then the code.
2. `BUILD-PLAN.md`: who builds what, in what order (Wave 1 P0 → Wave 2 lanes A–F in parallel → Wave 3 Z). If you were started as a lane, do only that lane.
3. `contracts/`: exact JSON shapes (Data Tables, webhooks, API responses + fixtures).
4. `n8n/CONVENTIONS.md`: pinned n8n version, how to start it, typeVersions, table / workflow / credential IDs.

## Rules that bite
- Own only your lane's files. Contract or seed changes go through Sergio.
- Code nodes can't read Data Tables: Data Table node → Code → Data Table node.
- Build workflow JSON from `n8n/templates/` (snippets that ran here, full node definitions, versions); never guess `typeVersion`s.
- Push with `node scripts/n8n.mjs push <file>` (n8n CLI, no API key; live in ~10–15 s). Test with `node scripts/n8n.mjs call …`. Pull back after any UI fix. Keep each file's fixed `id` from `n8n/ids.json`.
- n8n must be running: preview server `leftover-n8n` or the command in `n8n/CONVENTIONS.md`. A new or empty instance: `node scripts/setup-instance.mjs`, then reset (`n8n/README.md`).
- Test data only under your lane's test user (`test-a` … `test-f`). Only P0, Lane A and Z touch `maya` or call `/lo/demo/reset`.
- Pure logic in `lib/*.mjs` (no imports, no npm), tested with `node --test`, pasted verbatim into Code nodes.
- No secrets in the repo. Paper trading only (`https://paper-api.alpaca.markets`).
- On every page: "Educational prototype using simulated (paper) trading. Not investment advice. Projections are illustrative."
