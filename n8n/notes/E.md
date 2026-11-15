# Lane E notes: LO-08 Dashboard API + LO-07 Weekly Digest

Status 2026-11-14: both workflows live on the shared n8n (published, fixed ids `leftoverWF08apis`, `leftoverWF07dgst`).
`node scripts/check-api.mjs` passes for `maya` and `test-e`; the digest works in `dry_run`; `npm test` is green.

## Files
| File | What |
|---|---|
| `lib/projection.mjs` (+ `.test.mjs`) | All read-side logic, pure: FV, streaks, "your choices", summary lines, audits, portfolio, projection, settings validation, digest facts / prompt / LLM check / template / email. Tests rebuild every `contracts/fixtures/*.json` exactly from table rows. |
| `scripts/build-wf07-08.mjs` | **Generates** both workflow files and pastes `lib/week.mjs` + `lib/projection.mjs` verbatim into the Code nodes (same idea as `build-wf00.mjs`). Edit the lib or the builder, never the JSON or the n8n UI. |
| `n8n/workflows/08-dashboard-api.json` | 5 rows, one per route, into one shared `Respond` node (47 nodes). |
| `n8n/workflows/07-weekly-digest.json` | Webhook + Execute Workflow Trigger → facts → LLM → Gmail → envelope or data (22 nodes). |
| `scripts/check-api.mjs` | Live shape check against the fixtures (Z reuses it). |

## How to test
```bash
npm test                                         # lib + fixtures + seed tests
node scripts/check-api.mjs                       # maya + test-e, all 5 endpoints, error envelopes, test-e settings write round-trip
node scripts/check-api.mjs maya --no-write       # read-only, any user
node scripts/n8n.mjs call GET 'lo/api/summary?user_id=maya'
node scripts/n8n.mjs call POST lo/digest/send '{"user_id":"test-e","dry_run":true}'
node scripts/n8n.mjs call POST lo/digest/send '{"user_id":"maya","dry_run":true}'   # read-only, safe on maya
```
Change something → `node scripts/build-wf07-08.mjs` → `node scripts/n8n.mjs push n8n/workflows/08-dashboard-api.json` (and/or 07) → wait ~15 s → `node scripts/check-api.mjs`.

## LO-08 behaviour worth knowing
- Every route: header `x-lo-key`; `responseMode: responseNode`; Code returns `{status, body}`, the shared Respond node sends it. Errors: `400 BAD_REQUEST` (no `user_id`, bad `rate`, bad settings field), `404 NOT_FOUND` (unknown user), `500 INTERNAL` (Code threw).
- Data Table reads are filtered by `user_id`, `executeOnce` + `alwaysOutputData` (an empty table yields one `{}` item; the lib ignores it). So every key is present even for a user with no audits / orders / transactions (empty-safe, as `contracts/api.md` asks).
- **Portfolio positions are derived from the user's own `orders` rows** (filled qty, cost basis, contributions), not from Alpaca `GET /v2/positions`, because all users share one paper account. Alpaca only supplies the latest trade price (`data.alpaca.markets/v2/stocks/trades/latest?feed=iex`) and the clock (`/v2/clock`, paper base URL from config, forced to `paper-api`). Without Alpaca: price = last fill price, `market_open: null`, `next_open: null`. Queued orders always show `estimated_value_usd = notional_usd`.
- FX: Frankfurter `api.frankfurter.dev/v1/latest?base=USD&symbols=CAD` (no key), fallback config `fx_fallback_usdcad` with `fx_source: "fallback"`.
- Settings: only real changes are written (a no-op POST writes nothing, so `check-api` can POST for maya safely). Update user → If → update budgets (one item per changed budget) → re-read → respond. Verified the Data Table update only touches the columns in the item.
- `onboarding_url` = `<n8n base from the webhook URL>/form/lo-onboarding`. **Lane D:** if LO-01's form path isn't `lo-onboarding`, tell me (or change `onboardingUrlFrom` in the lib).
- `demo_mode` comes from config; `next_audit_at` is this Sunday 20:00 Vancouver (DST-aware), even after it has passed on Sunday night.

## LO-07 behaviour
- Input `{user_id, audit_id?, dry_run?}` from the webhook body or from LO-04's Execute Workflow item (passthrough; Lane A calls it with `mode: each`). Default audit: the user's latest by `week_start`.
- Facts: scoreboard, best category, unspent, over, to cushion, cushion vs target, invested this week (or carried / paused / ready), lifetime invested, portfolio value (orders-derived, as above), FV of this week's amount at each config rate × 10/20/30 years.
- Summary: LLM (Basic LLM Chain + Anthropic chat model sub-node, `claude-sonnet-5-5`, temp 0.4). Its text is used only if `checkDigestText` passes: 60–160 words, no tickers/"ETF", no buy/sell/guarantee wording, mentions the best category, labels any "years" projection "illustrative", no markdown. Otherwise the fixed template (80–120 words, tested for every status).
- Subject: `Your week: $X invested` / `ready to invest` / `$X carried to next week` / `investing is paused`.
- Recipient: config `demo_email_to` for `maya` when set, else `users.email`.
- Responses: webhook gets the envelope (`data`: `user_id, audit_id, dry_run, sent_to, subject, body, body_source`); LO-04 gets the bare `data` object, or the error envelope `{ok:false, error}` (never throws). Gmail failure / not connected → `502 UPSTREAM_ERROR` with the computed email in `data`. No email address → `400`. Unknown user / audit → `404`.

## Credentials (none exist yet)
`n8n publish:workflow` refuses (a) a credential reference that doesn't exist (`uses invalid credential`) and (b) nodes whose credential is required but missing (Gmail, the chat model). So the builder attaches a credential **only when its id is in `n8n/ids.json`**:

| ids.json key | Credential | Nodes | Until it exists |
|---|---|---|---|
| `credentials.alpaca_paper` | `Alpaca Paper` (httpCustomAuth) | `Summary/Portfolio/Digest: Alpaca prices`, `Portfolio: Alpaca clock` | auth type set, nothing attached → fails fast → fallback |
| `credentials.llm` | `LLM` (anthropicApi) | `Digest: LLM summary` + `LLM chat model` | both **disabled** → template text |
| `credentials.gmail` | `Gmail` (gmailOAuth2) | `Digest: send email` | **disabled** → `502 UPSTREAM_ERROR` "Gmail credential is not connected yet" |

To switch them on (Z): create the credential with a fixed id (`n8n import:credentials`, like `LO Webhook Key`), add the id to `n8n/ids.json`, `node scripts/build-wf07-08.mjs`, push both. If you attach in the UI instead, also add the id to ids.json, or the next rebuild drops it. If the LLM provider ends up OpenAI (D4), swap `lmChatAnthropic` for `lmChatOpenAi` in the builder (`LLM_CRED` type `openAiApi`); the chain and checks stay.

## Test data (`test-e`)
Rows in users, budgets (4, `shopping` inactive), transactions (this week: refund, pending→posted pair, still-pending row, excluded rent, removed row, inactive-category row, last-week row), audits (4: `skipped_paused`, `invested`, `carried`, `invested`), orders (2 filled, 2 queued `accepted`/`new`, 1 `rejected` + its `-r1` retry). Dates are relative to the week they were seeded in (2026-11-14).
Reseed (rewrites only test-e): `node scripts/build-wf07-08.mjs --dev` → push 08 → `node scripts/n8n.mjs call POST lo/dev-e/seed-test-e '{}'` → `node scripts/build-wf07-08.mjs` → push 08 again (the dev routes must not ship). `--dev` also adds `POST /lo/dev-e/call-digest`, which calls LO-07 through Execute Workflow exactly like LO-04 (used to verify the internal path).

## Left / known gaps
- **Not run live:** the LLM call, Gmail send, Alpaca prices and clock (no credentials). Only their fallback paths are verified. After credentials: `call POST lo/digest/send '{"user_id":"test-e"}'` with `demo_email_to` set, and `check-api` (portfolio should then show `market_open` true/false).
- A Code-node exception returns a `500 INTERNAL` envelope but the execution succeeds, so it does **not** reach LO-09 (contract says INTERNAL also reaches LO-09). Fix in Wave 3 by adding a Stop and Error node after Respond on that path (its typeVersion isn't in `n8n/templates/` yet).
- Snippets for nodes that now ran here (Respond to Webhook with dynamic status, HTTP Request with `onError`, If v2.4, Data Table update with autoMap, Execute Workflow `mode: each`, Basic LLM Chain + Anthropic sub-node) can be copied into `n8n/templates/node-snippets.json` (P0-owned) from the two workflow files.
- Summary reads all of a user's transactions every call (fine at demo scale).
