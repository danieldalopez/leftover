# Contract: dashboard API (LO-08)

Derived from `spec.md` §10 WF08, §13 and §19; if they disagree, the spec wins. Lane E implements this exactly; Lane F builds against it.

- **Auth and envelope:** see `webhooks.md`.
- **Fixtures:** `fixtures/*.json` show Maya on **Sat 2026-11-14 15:30** after a reset plus a backfill of her 3 past weeks. They're consistent with `demo/seed-data.json` (checked by `scripts/fixtures.test.mjs`).
- **Field rule:** a field may be `0` or `null`, but it's never missing. F can rely on every key in the fixture being present.
- **No polling:** the dashboard calls these on page load and after a button press only. On n8n Cloud every call is an execution.

| Endpoint | Fixture | Used by page |
|---|---|---|
| `GET /lo/api/summary?user_id=` | `summary.json` | This week (+ header numbers everywhere) |
| `GET /lo/api/audits?user_id=` | `audits.json` | History |
| `GET /lo/api/portfolio?user_id=` | `portfolio.json`, `portfolio-queued.json` | Portfolio |
| `GET /lo/api/projection?user_id=&rate=` | `projection.json` | Compounding |
| `POST /lo/api/settings` | `settings.json` | Settings (body in `webhooks.md`) |
| any, on failure | `error.json` | all |

---

## summary
The current week, live.
- `week.days_left`: today counts (Mon = 7 … Sun = 1), from `daysLeft()` in `lib/week.mjs`.
- `week.next_audit_at`: this Sunday 20:00 America/Vancouver.
- `lines[]`: one per active budget, in budget order. Each has:
  - `actual_cad`: counted per `data-tables.md` "What counts toward a week" (pending included);
  - `pending_cad`: the pending part of `actual_cad`;
  - `remaining_cad` = max(planned − actual, 0) and `over_cad` = max(actual − planned, 0);
  - `pct_used` = actual / planned, rounded to 2 decimals (0 if planned is 0);
  - `state`: `ok` below 0.8, `near` from 0.8 to 1.0, `over` above 1.0.
- `projected_actual_cad` = actual × 7 ÷ days elapsed (Mon = 1 … Sun = 7). `projected_under_cad` = max(planned − projected, 0). Pace projection, labelled as an estimate in the UI.
- `totals.projected_leftover_cad` = Σ `projected_under_cad` (gross, before the cushion).
- `buffer`: from `users`.
- `lifetime.invested_cad`: Σ `investable_cad` of audits with status `invested`.
- `last_audit`: the most recent audit, or `null`.
- `portfolio`: positions derived from the user's orders (as in `/lo/api/portfolio`); `queued_usd` = Σ `notional_usd` of orders still `queued`.

## audits
Every audit for the user, **newest first**.
- Each audit mirrors the `audits` row, with `lines_json` parsed into `lines` and money fields suffixed `_cad`.
- `best_category`: the line with the largest `under_cad` (ties → budget order), or `null` if nothing was under.
- `totals`: sums across all audits.
- `streaks[]`, one per category:
  - `weeks_under`: weeks with actual ≤ planned;
  - `current_streak`: consecutive such weeks counting back from the newest audit.

## portfolio
- `positions[]`: derived from the user's own filled orders (all users share one paper account, so Alpaca `GET /v2/positions` can't be split per user), valued at Alpaca's latest trade price (IEX), or the last fill price without Alpaca; plus `sleeve` (from config `sleeve_symbols`) and `contributed_cad` (Σ `notional_cad` of that symbol's filled orders).
- `orders[]`: every order for the user, newest first. `status` is the mapped status (spec §19.2) and `alpaca_status` is the raw one.
- While queued: `filled_qty` and `filled_avg_price` are `0`, `filled_at` is `null`, and `estimated_value_usd` = `notional_usd`. Once filled, `estimated_value_usd` is `null`.
- `market_open` and `next_open`: from Alpaca `GET /v2/clock`; both `null` without Alpaca (spec §19.5). When orders are queued and the market is closed, the UI shows "Queued · fills at Monday's open" (`portfolio-queued.json` is that state).
- `totals.unrealized_pl_pct` = unrealized ÷ cost basis, 4 decimals.

## projection
All three rates in one response, so the 4/6/8% toggle needs no new call.
- `FV = amount × (1 + r)^years`, rounded to cents (`lib/projection.mjs`).
- `lifetime.contributed_cad` = `summary.lifetime.invested_cad`.
- `last_week`: the latest invested audit; `null` if none.
- `your_choices[]`: per category, `leftover_cad` = Σ `under_cad` over all audits (gross leftover that category created, before the cushion), sorted by `leftover_cad` descending. `fv_30y_cad` is keyed by rate.
- `disclaimer` must be shown wherever these numbers appear.

## settings (POST)
Applies the given fields, then returns the full settings in the `settings.json` shape.
- `budgets[]` entries update `weekly_amount` (and optionally `active`) by `category_key`.
- `status: "paused"` makes the next audit write `skipped_paused`.
- `onboarding_url` is the LO-01 form URL (for "Retake quiz").
- Validation: `cushion_rate` must be 0–1, amounts ≥ 0, `status` must be `active` or `paused`. Anything else → `400 BAD_REQUEST`.
