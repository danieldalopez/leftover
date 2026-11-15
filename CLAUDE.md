# Leftover

Hackathon project (Loop Hackathon, eProjects x n8n). n8n workflows are the backend and the judged deliverable; `dashboard/` is a Next.js front end that only calls n8n webhooks. The build is finished; work now is fixes and demo prep.

## Read in this order
0. `STATUS.md`: where things stand, what was done, next steps (the handoff page).
1. `spec.md`: **the single source of truth.** If code and spec disagree, the spec wins. Change the spec first (Sergio approves), then the code.
2. `contracts/`: exact JSON shapes (Data Tables, webhooks, API responses + fixtures).
3. `n8n/CONVENTIONS.md`: pinned n8n version, how to start it, typeVersions, table / workflow / credential IDs.

`BUILD-PLAN.md` and `n8n/notes/A.md` … `F.md` are the record of how it was built (parallel lanes A–F). Read a note when you touch that workflow; the plan itself is history.

## Rules that bite
- Contract or seed changes go through Sergio.
- Code nodes can't read Data Tables: Data Table node → Code → Data Table node.
- Build workflow JSON from `n8n/templates/` (snippets that ran here, full node definitions, versions); never guess `typeVersion`s.
- Push with `node scripts/n8n.mjs push <file>` (n8n CLI, no API key; live in ~10–15 s). Test with `node scripts/n8n.mjs call …`. Pull back after any UI fix. Keep each file's fixed `id` from `n8n/ids.json`.
- n8n must be running: preview server `leftover-n8n` or the command in `n8n/CONVENTIONS.md`. A new or empty instance: `node scripts/setup-instance.mjs`, then reset (`n8n/README.md`).
- Pure logic lives in `lib/*.mjs` (no imports, no npm), tested with `node --test`, and is pasted verbatim into Code nodes. After any edit to a lib file, even a comment, the copies must follow or `npm test` fails:
  - LO-00, LO-07, LO-08: `node scripts/build-wf00.mjs` / `node scripts/build-wf07-08.mjs`;
  - LO-01: `LO_UPDATE_WF01=1 npm test`;
  - LO-02 … LO-06: re-paste by hand.

  Then push the changed workflows.
- Try things on a test user (`test-a` … `test-f`), not on `maya`. `/lo/demo/reset` reseeds Maya.
- No secrets in the repo. Paper trading only (`https://paper-api.alpaca.markets`).
- On every page: "Educational prototype using simulated (paper) trading. Not investment advice. Projections are illustrative."
- The dashboard has one look: blocky pixel theme, square corners, bevelled panels (`dashboard/app/globals.css`). Each page shows a few numbers that matter and keeps the rest out of the way.
