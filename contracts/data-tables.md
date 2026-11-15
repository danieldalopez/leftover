# Contract: Data Tables

Derived from `spec.md` §9; if they disagree, the spec wins. LO-00 creates every table. Table IDs are in `n8n/CONVENTIONS.md`.

**Types:** `string` · `number` · `boolean` · `date`. A `date` is a real moment in time and comes back as an ISO timestamp.

**Date-only values are strings** (`YYYY-MM-DD`). Read them with `calendarDate()` and never pass them through a timezone (`lib/week.mjs`).

n8n adds its own `id`, `createdAt` and `updatedAt` to every row. Don't rely on `id`: upsert on the **key** listed for each table (Data Tables don't enforce uniqueness).

JSON goes into `string` columns (`*_json`). Parse it in a Code node.

---

## users. Key: `user_id`
| column | type | notes |
|---|---|---|
| user_id | string | lowercase slug; demo user `maya`, lane test users `test-a` … `test-f` |
| email | string | |
| name | string | |
| created_at | date | |
| timezone | string | always `America/Vancouver` in v1 |
| status | string | `active` \| `paused` |
| consent_at | date | standing consent to invest weekly leftover |
| buffer_balance | number | CAD |
| buffer_target | number | CAD, default 100 |
| cushion_rate | number | 0–1, default 0.5 |
| absorb_overspend | boolean | default true (D2) |
| min_invest | number | CAD, default 5 |
| max_weekly_invest | number | CAD, default 200 |
| pending_carry | number | CAD carried from weeks under `min_invest` |
| deficit_carry | number | CAD of late-posting deficit still to deduct (§6.6) |

Written by: LO-00 (seed), LO-01 (create), LO-04 (buffer and carries), LO-05 (`pending_carry` after investing), LO-08 (settings).

## profiles. Key: `user_id`
| column | type | notes |
|---|---|---|
| user_id | string | |
| answers_json | string | quiz answers object (keys as in the seed's `profile.answers`) |
| capacity_score | number | 0–100 |
| willingness_score | number | 0–100 |
| tier | string | `cash` \| `conservative` \| `balanced` \| `growth` \| `all_equity` |
| home_bias | string | `global` \| `more_canada` |
| allocation_json | string | `{"equity_us":0.36,"equity_intl":0.21,"equity_ca":0.03,"bonds":0.40,"cash":0}`: weights sum to 1, user editable |
| explanation | string | LLM text, general language |
| updated_at | date | |
| warnings_json | string | array of warning codes, e.g. `["low_emergency_fund","high_interest_debt"]` |

Written by: LO-00, LO-01.

## budgets. Key: `user_id` + `category_key`
| column | type | notes |
|---|---|---|
| user_id | string | |
| category_key | string | `groceries` `eating_out` `transport` `entertainment` `shopping` `personal_care` `other` |
| label | string | display name |
| weekly_amount | number | CAD |
| active | boolean | inactive categories are ignored by the audit |

Written by: LO-00, LO-01, LO-08 (settings).

## category_map. Key: `plaid_pfc_primary` + `plaid_pfc_detailed`
| column | type | notes |
|---|---|---|
| plaid_pfc_primary | string | e.g. `FOOD_AND_DRINK` |
| plaid_pfc_detailed | string | e.g. `FOOD_AND_DRINK_GROCERIES`; **empty = default for that primary** |
| category_key | string | a budget key, or `excluded` |
| excluded | boolean | true for fixed costs, transfers, income |

Lookup order: exact (primary, detailed) → (primary, `""`) → `other`. Written by: LO-00 only.

## bank_links. Key: `item_id`
| column | type | notes |
|---|---|---|
| user_id | string | |
| item_id | string | Plaid item |
| access_token | string | **sandbox only**: storing it in a table is a production risk, say so in the pitch |
| cursor | string | `/transactions/sync` cursor, empty before the first sync |
| institution_name | string | |
| linked_at | date | |

Written by: LO-02, LO-03 (cursor).

## transactions. Key: `txn_id`
| column | type | notes |
|---|---|---|
| txn_id | string | Plaid `transaction_id`, or `manual-…` / `seed-…` |
| user_id | string | |
| date | **string** | `YYYY-MM-DD` local calendar date. Plaid rows: `authorized_date` when present, else `date` (spec §6.3) |
| amount | number | CAD; positive = money out, negative = money in (refund) |
| merchant | string | |
| pfc_primary | string | empty for manual entries |
| pfc_detailed | string | empty for manual entries |
| category_key | string | budget key or `excluded` |
| pending | boolean | |
| pending_txn_id | string | on a posted row: the pending row it replaces (that pending row then never counts) |
| source | string | `plaid` \| `manual` \| `seed` |
| removed | boolean | removed rows never count |
| synced_at | date | |

**What counts toward a week** (§6.3): rows with `removed = false`, a budget `category_key`, a `date` inside the week, and not superseded (no other **non-removed** row has `pending_txn_id` = this row's `txn_id`). Pending rows count.

Written by: LO-00, LO-03, LO-03b.

## audits. Key: `audit_id`
| column | type | notes |
|---|---|---|
| audit_id | string | `{user_id}-{week_start}` |
| user_id | string | |
| week_start | **string** | `YYYY-MM-DD`, a Monday |
| week_end | **string** | `YYYY-MM-DD`, the Sunday |
| lines_json | string | `[{"category_key","label","planned","actual","under","over"}]` |
| gross_surplus | number | CAD |
| total_over | number | CAD |
| late_adj | number | CAD |
| to_buffer | number | CAD |
| buffer_after | number | CAD |
| investable_cad | number | CAD actually sent to LO-05 (0 if carried) |
| pending_carry_after | number | CAD |
| status | string | `computed` \| `invested` \| `carried` \| `skipped_paused` |
| created_at | date | |

Written by: LO-04, LO-05 (status → `invested`).

## orders. Key: `client_order_id`
| column | type | notes |
|---|---|---|
| client_order_id | string | `{audit_id}-{symbol}`, retry `…-r1` |
| audit_id | string | |
| user_id | string | |
| symbol | string | from config `sleeve_symbols` |
| sleeve | string | `equity_us` \| `equity_intl` \| `equity_ca` \| `bonds` \| `cash` |
| notional_usd | number | |
| notional_cad | number | |
| fx_rate | number | CAD per 1 USD used for this order |
| alpaca_order_id | string | |
| status | string | **raw Alpaca status** (`accepted`, `filled`, …); the API maps it (spec §19.2) |
| filled_qty | number | 0 until filled |
| filled_avg_price | number | USD, 0 until filled |
| submitted_at | date | |
| filled_at | date | empty until filled |

Written by: LO-05, LO-06.

## config. Key: `key`
| column | type |
|---|---|
| key | string |
| value | string |

Keys and meanings: spec §9. Seed values: `demo/seed-data.json`. Written by: LO-00 only (Z sets `demo_email_to` and `dashboard_url`).
