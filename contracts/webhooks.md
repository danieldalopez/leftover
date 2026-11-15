# Contract: webhooks and internal calls

Derived from `spec.md` §19.1 and §19.2; if they disagree, the spec wins. The dashboard-facing GET endpoints (`/lo/api/*`) are detailed in `api.md`.

**Base URL:** `${N8N_BASE_URL}/webhook/` (production URL; the workflow must be active).

**Auth:** header `x-lo-key: ${N8N_WEBHOOK_KEY}` via the `LO Webhook Key` Header Auth credential. A wrong or missing key gets n8n's own `403 Authorization data is wrong!`, not our envelope.

**Envelope:** success `{"ok": true, "data": {...}}`. Failure `{"ok": false, "error": {"code", "message"}}` with an HTTP status.

| code | HTTP | when |
|---|---|---|
| `BAD_REQUEST` | 400 | missing or invalid field |
| `NOT_FOUND` | 404 | unknown user, audit, … |
| `UPSTREAM_ERROR` | 502 | Alpaca / Plaid / FX / LLM / Gmail failed |
| `INTERNAL` | 500 | anything else (also reaches LO-09) |

Money: dollars rounded to cents, `_cad` / `_usd` suffixes. Dates `YYYY-MM-DD`; timestamps ISO 8601 with offset.

```bash
# how every lane tests
curl -s -X POST "$N8N_BASE_URL/webhook/lo/audit/run" \
  -H "x-lo-key: $N8N_WEBHOOK_KEY" -H 'content-type: application/json' \
  -d '{"user_id":"test-a"}'
```

---

## POST /lo/demo/reset (LO-00)
Request `{}`. Deletes every row for `maya` in users, profiles, budgets, transactions, audits and orders, then reseeds from `demo/seed-data.json`. It also re-upserts `config` and `category_map` (keeping `demo_email_to` and `dashboard_url` if already set). Other users are untouched.
```json
{ "ok": true, "data": { "user_id": "maya", "week_start": "2026-11-09", "transactions_seeded": 43, "budgets_seeded": 7 } }
```

## POST /lo/plaid/connect-sandbox (LO-02)
Request `{ "user_id": "test-c" }`
```json
{ "ok": true, "data": { "user_id": "test-c", "item_id": "…", "institution_name": "First Platypus Bank", "sync": { "added": 12, "modified": 0, "removed": 0 } } }
```

## POST /lo/sync (LO-03)
Request `{ "user_id"?: "test-c" }` (default: every user with a bank link)
```json
{ "ok": true, "data": { "users": 1, "added": 3, "modified": 1, "removed": 0 } }
```

## POST /lo/demo/add-txn (LO-03)
Request `{ "user_id": "test-c", "merchant": "Banh Mi Saigon", "amount_cad": 14.00, "date"?: "2026-11-14" }`. Creates a Plaid sandbox transaction, refreshes, syncs.
```json
{ "ok": true, "data": { "user_id": "test-c", "sync": { "added": 1, "modified": 0, "removed": 0 } } }
```

## POST /lo/expense (LO-03b)
Request `{ "user_id": "maya", "amount_cad": 14.00, "category_key": "eating_out", "merchant": "Banh Mi Saigon", "date"?: "2026-11-14" }` (date defaults to today, Vancouver)
```json
{ "ok": true, "data": { "txn_id": "manual-…", "user_id": "maya", "date": "2026-11-14", "amount_cad": 14.00, "category_key": "eating_out" } }
```

## POST /lo/audit/run (LO-04)
Request `{ "user_id"?: "maya", "week_start"?: "2026-11-09", "invest"?: true }`. Defaults: every active user, the current week, `invest: true`. `invest: false` writes the audit and never calls LO-05 (for backfills). Re-running a week already `invested` changes nothing and returns it.
```json
{
  "ok": true,
  "data": {
    "audits": [
      {
        "audit_id": "maya-2026-11-02", "user_id": "maya", "week_start": "2026-11-02", "status": "invested",
        "gross_surplus_cad": 52.30, "total_over_cad": 12.40, "late_adj_cad": 0, "to_buffer_cad": 26.15,
        "buffer_after_cad": 41.00, "investable_cad": 26.15, "pending_carry_after_cad": 0,
        "invest": { "…": "LO-05 response data, or null when not invested" }
      }
    ]
  }
}
```

## POST /lo/invest/run (LO-05 test entry), same as the internal call from LO-04
Request `{ "audit_id": "maya-2026-11-02", "user_id": "maya", "investable_cad": 26.15 }`
```json
{
  "ok": true,
  "data": {
    "audit_id": "maya-2026-11-02", "user_id": "maya", "status": "invested",
    "fx_rate": 1.3810, "fx_source": "frankfurter",
    "invested_cad": 26.15, "invested_usd": 18.94,
    "orders": [
      { "client_order_id": "maya-2026-11-02-VTI",  "symbol": "VTI",  "sleeve": "equity_us",   "notional_cad": 9.41,  "notional_usd": 6.81, "status": "queued", "alpaca_status": "accepted", "duplicate": false },
      { "client_order_id": "maya-2026-11-02-VXUS", "symbol": "VXUS", "sleeve": "equity_intl", "notional_cad": 5.49,  "notional_usd": 3.98, "status": "queued", "alpaca_status": "accepted", "duplicate": false },
      { "client_order_id": "maya-2026-11-02-BND",  "symbol": "BND",  "sleeve": "bonds",       "notional_cad": 11.25, "notional_usd": 8.15, "status": "queued", "alpaca_status": "accepted", "duplicate": false }
    ]
  }
}
```
- `fx_source`: `frankfurter` | `fallback`.
- `duplicate: true` means Alpaca already had that `client_order_id`. It counts as success.
- In this example EWC (3%) was below the $1 minimum and was folded into the largest sleeve.

## POST /lo/reconcile/run (LO-06)
Request `{}`
```json
{ "ok": true, "data": { "checked": 3, "updated": 3, "retried": 0, "failed": 0 } }
```

## POST /lo/digest/send (LO-07), same as the internal call from LO-04
Request `{ "user_id": "maya", "audit_id"?: "maya-2026-11-02" }` (default: the user's latest audit)
```json
{ "ok": true, "data": { "user_id": "maya", "audit_id": "maya-2026-11-02", "sent_to": "…", "subject": "Your week: $26.15 invested" } }
```

## POST /lo/api/settings (LO-08)
Request (every field except `user_id` is optional):
```json
{ "user_id": "maya", "status": "paused", "buffer_target": 120, "cushion_rate": 0.5, "absorb_overspend": true,
  "budgets": [ { "category_key": "eating_out", "weekly_amount": 45 } ] }
```
Response: `fixtures/settings.json` (the full settings after the update).

---

## Internal calls (Execute Workflow)
| From → To | Input | Returns |
|---|---|---|
| LO-04 → LO-05 | `{audit_id, user_id, investable_cad}` | the `data` object of `/lo/invest/run` |
| LO-04 → LO-07 | `{user_id, audit_id}` | the `data` object of `/lo/digest/send` |
| LO-02 → LO-03 | `{user_id}` | the `data` object of `/lo/sync` |

Until a lane fills in its workflow, its stub returns `{"ok": true, "stub": true}`. Callers must not break on that.
