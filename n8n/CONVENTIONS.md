# n8n conventions

Facts about **this** n8n that every lane relies on, all verified on 2026-11-14. Behaviour lives in `spec.md`; this file covers the tooling.

## Instance
- **n8n 2.47.7**, self-hosted with `npx` on Sergio's Mac (no Docker), Node 26. Data lives in `~/.n8n` (SQLite).
- Start it:
  - in the Claude desktop app, preview server **`leftover-n8n`** (defined in `~/Claude/.claude/launch.json`);
  - or in a terminal:
    ```bash
    GENERIC_TIMEZONE=America/Vancouver TZ=America/Vancouver N8N_DIAGNOSTICS_ENABLED=false npx -y n8n@2.47.7
    ```
- Webhooks: `http://localhost:5678/webhook/<path>`. Only the JS task runner exists (no Python), so write JavaScript Code nodes only.
- **No n8n API key and no owner login are needed to build.** The owner account (created in the editor UI by Sergio) is only needed to *look at* the canvas, e.g. for the demo.

## Pushing and testing workflows (no key)
`scripts/n8n.mjs` uses n8n's own CLI when `.env` has no `N8N_API_KEY`:

| Command | What it does |
|---|---|
| `node scripts/n8n.mjs push n8n/workflows/04-weekly-audit.json` | `import:workflow` + `publish:workflow`. The **running** n8n serves the new version after **~10–15 s**, no restart. |
| `node scripts/n8n.mjs call POST lo/audit/run '{"user_id":"test-a"}'` | Calls a webhook with `x-lo-key` from `.env`. |
| `node scripts/n8n.mjs pull leftoverWF04audt` | Exports from n8n back into the repo file, after a fix made in the UI. |
| `node scripts/n8n.mjs list` | Lists IDs and names. |

- After a push, wait ~15 s before calling (or retry). The first call may still hit the old version.
- Two sessions importing at the same instant can hit `database is locked`. The script says so; retry after a few seconds.
- If `N8N_API_KEY` is ever added to `.env`, the same commands switch to the REST API (instant), with no other change.
- **Inspect Data Table contents** (read-only) without the UI:
  ```bash
  sqlite3 -readonly -header ~/.n8n/database.sqlite "select * from data_table_user_$(sqlite3 -readonly ~/.n8n/database.sqlite "select id from data_table where name='transactions'") limit 5;"
  ```
  Never write to the database directly. Go through workflows.

## Fixed IDs
- `n8n/ids.json` holds **fixed** IDs for every workflow (`leftoverWF04audt`, …) and for the `LO Webhook Key` credential (`leftoverCredHook`). Every workflow file carries its `id`; never remove it or change it.
- Because the IDs are fixed, Execute Workflow nodes can reference `n8n/ids.json` IDs and they stay valid on any instance we CLI-import into.
- `"active": true` in a workflow file means `push` publishes it. Only workflows with a webhook or schedule trigger can be active (a manual-only or error-trigger workflow can't).

## Building workflow JSON
- `n8n/templates/node-versions.json`: `typeVersion` to use for each node (`latest`).
- `n8n/templates/node-snippets.json`: node JSON copied from workflows that **ran** here (webhook with header auth, Code, every Data Table operation we use, …). Copy from it.
- `n8n/templates/node-types.json`: full parameter definitions of the 26 node types this project uses (from `n8n export:nodes`). Use it for nodes with no snippet yet (Schedule, HTTP Request, If, Merge, Execute Workflow, Respond to Webhook, Form, LLM). When yours runs, add it to the snippets.
- Generated files: `00-setup-and-seed.json` is built by `scripts/build-wf00.mjs` (seed + `lib/week.mjs` embedded); stubs by `scripts/build-stubs.mjs`. Edit the sources, rebuild, push.
- Every workflow: `settings: { "executionOrder": "v1", "timezone": "America/Vancouver" }`. Z adds `errorWorkflow: "leftoverWF09errh"` in Wave 3.
- Webhook nodes: `authentication: "headerAuth"` with credential `{ "id": "leftoverCredHook", "name": "LO Webhook Key" }`, and a unique `webhookId` (any UUID). `responseMode: "lastNode"` + `responseData: "firstEntryJson"` returns the last node's first item. Use `"responseNode"` + a Respond to Webhook node when you need custom status codes (errors).

## Data Tables (verified by running LO-00)
- **The node creates tables:** `resource: "table"`, `operation: "create"`, `tableName`, `columns.column: [{name, type}]`, `options.createIfNotExists: true`. Re-running is safe.
- **Reference tables by name, never by ID:** `"dataTableId": { "__rl": true, "mode": "name", "value": "transactions" }`. That's portable to any instance.
- Row operations: `get`, `insert`, `update`, `upsert`, `deleteRows`, `rowExists`, `rowNotExists`. Table operations: `create`, `list`, `update`, `clear`, `delete`.
- Filters: `matchType: "allConditions" | "anyCondition"`, `filters.conditions: [{ keyName, condition: "eq", keyValue }]`.
- Insert maps each item's keys to columns: `columns: { mappingMode: "autoMapInputData", value: {}, matchingColumns: [], schema: [] }`. Extra keys that aren't columns: keep items clean.
- `get` and `deleteRows` return **no items** when nothing matches, which stops the flow. Set `alwaysOutputData: true` when it must continue.
- Nodes run once **per input item**. Use `executeOnce: true` on table operations that follow a multi-item step.
- Booleans are stored as `1`/`0` and dates as `YYYY-MM-DD HH:MM:SS.sss` (UTC) in SQLite. Date-only values are strings by contract, so they come back exactly as written.

## Credentials (exact names; fixed IDs in `n8n/ids.json` where created)
| Name | Type | Status |
|---|---|---|
| `LO Webhook Key` | Header Auth `x-lo-key` | **created** (`leftoverCredHook`); the value is `N8N_WEBHOOK_KEY` in `.env` |
| `Alpaca Paper` | Custom Auth (2 headers) | needed before Lane B |
| `Plaid Sandbox` | Custom Auth (body `client_id`, `secret`) | needed before Lane C |
| `LLM` | Anthropic or OpenAI | needed before Lanes D/E. **Provider not chosen yet (D4)** |
| `Gmail` | Gmail OAuth2 | needed before Lane E |

These four hold third-party keys, which Sergio enters in n8n himself. Until they exist, lanes build and test everything up to the external call, using stubs or mocks at that boundary.
