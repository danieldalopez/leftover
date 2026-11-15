# n8n conventions

Facts about **this** n8n that every lane relies on. Behaviour lives in `spec.md`; this file covers the tooling.

## Instance
- **n8n 2.47.7**, self-hosted with `npx` on Sergio's Mac (no Docker), Node 26. Data lives in `~/.n8n` (SQLite).
- Start it:
  - in the Claude desktop app, preview server **`leftover-n8n`** (defined in `~/Claude/.claude/launch.json`);
  - or in a terminal:
    ```bash
    GENERIC_TIMEZONE=America/Vancouver TZ=America/Vancouver N8N_DIAGNOSTICS_ENABLED=false npx -y n8n@2.47.7
    ```
- Editor: http://localhost:5678. Only the JS task runner is available (the Python runner isn't installed); use JavaScript Code nodes only.
- Timezone: America/Vancouver (instance env + every workflow's `settings.timezone`).

## Talking to n8n
- `scripts/n8n.mjs` wraps the public REST API (`N8N_API_KEY` in `.env`): `list`, `pull`, `push`, `activate`, `call`, `api`.
- **IDs:** `n8n/ids.json` (written by P0) holds every workflow ID and credential ID. Workflow files keep their `id` so `push` updates in place.
- **Production webhooks** (`/webhook/...`) only answer when the workflow is active. Run `node scripts/n8n.mjs activate <id>` after pushing.

## Building workflow JSON
- Node type versions: `n8n/templates/node-versions.json` (read from the installed `n8n-nodes-base`). Use `latest`.
- Real node shapes: `n8n/templates/node-snippets.json` (a reference workflow exported from this instance). Copy parameters from there; don't guess.
- Some workflow files are **generated**: `00-setup-and-seed.json` comes from `scripts/build-wf00.mjs` (seed + `lib/week.mjs` embedded). Edit the sources, rebuild, push.
- Every workflow has `settings: { "executionOrder": "v1", "timezone": "America/Vancouver" }`. Z adds `errorWorkflow` (LO-09) in Wave 3.

## Data Tables (verified against n8n-nodes-base `dataTable` v1.1)
- **The node can create tables:** `resource: "table"`, `operation: "create"`, `tableName`, `columns.column: [{name, type}]`, `options.createIfNotExists: true` (default). LO-00 does this, so it's safe to re-run.
- **Reference tables by name, never by ID:** `"dataTableId": { "__rl": true, "mode": "name", "value": "transactions" }`. This keeps workflows working after import into a fresh instance, with no re-linking.
- Row operations: `get`, `insert`, `update`, `upsert`, `deleteRows`, `rowExists`, `rowNotExists`. Table operations: `create`, `list`, `update` (rename), `clear`, `delete`.
- Filters: `matchType: "allConditions" | "anyCondition"`, `filters.conditions: [{ keyName, condition: "eq" | …, keyValue }]`.
- Insert/update/upsert use a resource mapper. `columns: { mappingMode: "autoMapInputData", value: {}, matchingColumns: [], schema: [] }` maps each item's keys to the columns with the same names.
- `get` returns **no items** when nothing matches. Set `alwaysOutputData: true` on the node if the flow must continue.
- Nodes run once **per input item**. Put `executeOnce: true` on table operations that sit after a multi-item step.

## Cross-workflow calls
- Execute Workflow nodes reference the callee by ID from `n8n/ids.json`. IDs change on a fresh instance, so Z re-links them (and credentials) in Wave 3. Data Tables don't need this, since they're referenced by name.

## Credentials (exact names; IDs in `n8n/ids.json`)
| Name | Type | Status |
|---|---|---|
| `LO Webhook Key` | Header Auth `x-lo-key` | created by P0; the value is `N8N_WEBHOOK_KEY` in `.env` |
| `Alpaca Paper` | Custom Auth (2 headers) | Sergio, before Lane B |
| `Plaid Sandbox` | Custom Auth (body `client_id`, `secret`) | Sergio, before Lane C |
| `LLM` | Anthropic or OpenAI | Sergio, before Lanes D/E. **Provider: not chosen yet (D4)** |
| `Gmail` | Gmail OAuth2 | Sergio, before Lane E |
