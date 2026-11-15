# spec.md: Leftover (working name)
**Invest what you didn't spend.** Loop Hackathon (eProjects x n8n), November 2026
Owner: Sergio Lopez. Builder: Sergio + Claude Code. Status: v1, locked for build (2026-11-14).

> **This file is the single source of truth.** Workflows, `contracts/`, `lib/` and the dashboard all follow it. If something here is wrong or missing, change this file first (Sergio approves), then the code, in that order. If code and spec disagree, the spec wins.
>
> - `BUILD-PLAN.md` says **who builds what, in what order** (parallel lanes). It doesn't define behaviour.
> - `contracts/` holds the exact JSON shapes derived from §9, §10 and §19. If a contract disagrees with this file, fix the contract.

---

## 0. Read this first (instructions for Claude Code)

You are building a hackathon project. The judged deliverable is **n8n workflow JSON files** that automate a personal finance loop, plus a **dashboard frontend**. Optimize for: a working end to end automation, a demo that never breaks, and clean importable JSON.

Rules for the build:
1. **n8n is the backend.** All business logic lives in n8n workflows. The dashboard only reads from and triggers n8n webhooks. No separate backend server.
2. **Storage = n8n Data Tables.** Code nodes cannot read Data Tables directly, so always fetch rows with a Data Table node first, then compute in a Code node, then write back with a Data Table node.
3. **Every workflow JSON must import cleanly** via n8n "Import from File". Before generating JSON, check the n8n version running (Settings > About, or `n8n --version`) and use node `typeVersion`s that exist in that version. Never embed secrets in JSON. Reference credentials by name; list required credentials in `n8n/README.md`.
4. **Every scheduled workflow also has a manual webhook trigger** so the demo can run it on demand ("Run audit now"). Judges cannot wait a week.
5. **Idempotency everywhere money moves.** Orders use `client_order_id = {audit_id}-{symbol}`. Audits are unique per `(user_id, week_start)`.
6. **Paper trading only.** Alpaca paper API. Never call a live trading URL.
7. Build in the waves and lanes in `BUILD-PLAN.md`; the milestones in section 17 still define "done". The audit + invest loop (WF4 + WF5) is the heart of the project and is never cut.
8. Follow the locked conventions in section 19 (routes, payloads, response format, users, seed format).

Repo layout:
```
leftover/
  spec.md                (this file: single source of truth)
  BUILD-PLAN.md          (parallel build plan: waves, lanes, file ownership)
  CLAUDE.md              (short pointer to spec.md + conventions)
  contracts/             (data-tables.md, webhooks.md, api.md, fixtures/*.json)
  lib/                   (pure functions + node --test tests, pasted into Code nodes)
  scripts/               (helper scripts: push workflows, check API shapes)
  n8n/
    README.md            (import order, credentials, env, how to test)
    CONVENTIONS.md       (pinned n8n version, typeVersions, table/workflow/credential IDs)
    templates/           (node-snippets.json exported from the running n8n)
    notes/               (one file per build lane, merged into README at the end)
    workflows/
      00-setup-and-seed.json
      01-onboarding-form.json
      02-plaid-connect-sandbox.json
      03-transaction-sync.json
      03b-manual-expense.json
      04-weekly-audit.json
      05-invest-executor.json
      06-order-reconcile.json
      07-weekly-digest.json
      08-dashboard-api.json
      09-error-handler.json
  dashboard/             (Next.js app, deploy to Vercel)
  demo/
    seed-data.json       (4 weeks of realistic transactions for 1 demo user)
    demo-script.md
```

---

## 1. One liner and pitch

**One liner:** Set a weekly budget per category. Every Sunday night, an n8n workflow audits what you actually spent, and whatever you didn't spend in each category is automatically invested into a long term ETF portfolio matched to your profile.

**Pitch line:** Round-up apps reward you for spending. Leftover rewards you for spending less, and shows you what each small choice compounds into.

---

## 2. Problem and evidence

Young Canadians are saving but not investing, often because they feel they don't have "enough" to start or don't know how.

- TD survey (Oct 2025, Léger, n=1,500): 41% of Gen Z and Millennial Canadians with a TFSA aren't investing the money in it. 35% of Gen Z aren't sure where or how to begin; 16% find investing too complicated.
- Same survey coverage: 22% of Gen Z and Millennials not investing their TFSA said they didn't have enough money saved to invest.
- TD survey (Jul 2025, n=3,037): only 37% of Gen Z Canadians feel in control of their money; 64% feel financial stress multiple times a week.
- National Payroll Institute 2025: Gen Z workers save an average of 11% of each paycheque, more than any other generation.

**Insight:** the saving habit exists; the gap is the bridge from "leftover cash sitting in chequing" to "invested". Leftover makes that bridge automatic and tied to a behaviour the user already controls (spending less), in amounts small enough that "I don't have enough" stops being a reason.

---

## 3. Competitive landscape and edge

| Product | Market | Mechanic | Invests? |
|---|---|---|---|
| Qapital "Spend Less Rule" | US | Budget per merchant (weekly/monthly); save the difference if under | Saves toward goals (Qapital has separate investing) |
| Wealthsimple Roundup | Canada | Rounds up card purchases, invests the change | Yes |
| Moka | Canada | Round-ups into ETF portfolios, $7 to $15/month | Yes |
| KOHO RoundUps | Canada | Round-ups into savings/investing | Partly |

**Honest read:** the core mechanic exists in the US (Qapital). In Canada I found round-up products but no mainstream "invest your underspend" product. Round-ups are tied to *spending more*; Leftover is tied to *spending less*.

**Edge (what we pitch):**
1. **Behaviour-linked investing**: you only invest because you made a choice to spend less. Category level feedback ("eating out gave you $18 this week").
2. **Compounding awareness**: every weekly digest translates this week's leftover into its illustrative 10/20/30 year value. Makes real choices feel real.
3. **Fully automated pipeline on n8n**: bank sync, audit, cushion, execution, reconciliation, digest. This is exactly what the hackathon judges.
4. **Canadian framing**: CAD budgets, TFSA/RRSP/FHSA awareness, home-bias option.

---

## 4. Target user

**Primary persona: "Maya", 25, Vancouver, 2 years into her first full time job.**
- Salaried, paid biweekly, about $3,800/month take home.
- Rent and phone are fixed; groceries, eating out, transport, fun are variable.
- Has a TFSA with cash in it she "means to invest". Tried budgeting apps, quit because they only show guilt, never reward.
- Wants: low effort, long horizon (retirement / general wealth), doesn't want to pick stocks.

**Out of scope for v1:** students without income, people carrying high-interest debt (we detect and warn, see 11.4), couples/shared budgets.

---

## 5. Goals, non-goals, success metrics

**Goals (hackathon)**
- G1: End to end automation runs with zero manual steps after onboarding: sync, weekly audit, invest, reconcile, digest.
- G2: Dashboard shows budget vs actual, weekly surplus history, portfolio, compounding projection.
- G3: Demo can simulate a full week in under 60 seconds.

**Non-goals**
- Real money trading. Real Canadian brokerage integration. Tax optimization. Multi-currency beyond CAD budgets and USD paper execution. Mobile app.

**Demo success metrics**
- Audit to filled/queued order in under 30s when triggered manually.
- 0 duplicate orders on repeated triggers (idempotency).
- All 10 workflows import into a fresh n8n instance without errors.

---

## 6. Core concepts and rules

### 6.1 Time
- Week = Monday 00:00 to Sunday 23:59, timezone **America/Vancouver**.
- Weekly audit runs **Sunday 20:00 America/Vancouver** (plus manual trigger).

### 6.2 Categories
Only **variable** spending is budgeted weekly. Fixed costs (rent, utilities, phone, subscriptions, transfers, income) are excluded from the audit because they aren't weekly decisions.

Default categories (user edits amounts at onboarding):

| key | label | default weekly budget (CAD) | Plaid PFC primary mapping (verify against Plaid PFC v2 docs) |
|---|---|---|---|
| groceries | Groceries | 80 | FOOD_AND_DRINK (detailed: groceries) |
| eating_out | Eating out and coffee | 50 | FOOD_AND_DRINK (detailed: restaurant, fast food, coffee) |
| transport | Transport | 30 | TRANSPORTATION |
| entertainment | Fun and entertainment | 40 | ENTERTAINMENT |
| shopping | Shopping | 40 | GENERAL_MERCHANDISE |
| personal_care | Personal care | 20 | PERSONAL_CARE |
| other | Other variable | 20 | fallback for unmapped variable spend |

Transactions in categories like RENT_AND_UTILITIES, TRANSFER_IN/OUT, INCOME, LOAN_PAYMENTS and LOAN_DISBURSEMENTS are stored but **excluded** from the audit. (LOAN_DISBURSEMENTS is new in PFC v2: without its own row, loan money coming in would fall back to `other` and look like a refund that cancels out spending.) Mapping lives in a `category_map` Data Table so it's editable without touching workflows.

### 6.3 Spend per category
`actual_c` = sum of outflows minus refunds for category c with transaction date in the week. Plaid convention: positive amount = money out; negative = money in (refund). Include **pending** transactions; when a pending one posts, dedupe using `pending_transaction_id`: a pending row stops counting once any non-removed row has `pending_txn_id` equal to its `txn_id`.

The transaction date is Plaid's `authorized_date` when present, else `date` (the posted date), so a purchase lands in the week it was made. A charge that posts days later is what the true-up (§6.6) catches.

### 6.4 Underspend (gross, per category, no cross-category netting)
Per Sergio's decision, categories are **not** netted against each other.
```
under_c = max(planned_c - actual_c, 0)
over_c  = max(actual_c - planned_c, 0)
gross_surplus = sum(under_c)
```

### 6.5 Variance cushion
A cash buffer that protects the user from investing money they'll need.
- `buffer_target` (default $100 CAD), `cushion_rate` (default 50%).
- **Fill rule:** while `buffer < buffer_target`, send `min(gross_surplus x cushion_rate, buffer_target - buffer)` to the buffer. Once full, 100% of surplus is invested.
- **Overspend absorption (setting, default ON, see open decision D2):** `buffer = max(buffer - sum(over_c), 0)`. This is how overspending is handled without netting categories directly: overspend drains the cushion, underspend refills it first.

### 6.6 Late-posting true-up
Card charges often post days later. Before computing this week, **re-audit last week** with current data. If last week's surplus shrank, `late_adj = old_surplus - new_surplus` is deducted from this week's investable amount (never negative; any excess carries forward as `deficit_carry`).

### 6.7 Investable amount
```
investable = gross_surplus - to_buffer - late_adj - deficit_carry + pending_carry
investable = min(investable, max_weekly_invest)   # default $200 safety cap
if investable < min_invest ($5 default): pending_carry = investable; invest nothing this week
```

### 6.8 Worked example
Budget vs actual: groceries 80 / 62, eating out 50 / 71, transport 30 / 22, entertainment 40 / 40.
- under: 18 + 0 + 8 + 0 = **$26 gross surplus**; over: eating out $21.
- Buffer starts at $60 (target $100). Overspend absorption ON: buffer 60 - 21 = $39.
- to_buffer = min(26 x 0.5, 100 - 39) = $13. Buffer = $52.
- late_adj = $0, pending_carry = $0. **Investable = $13 CAD**, split by allocation.

### 6.9 Currency
Budgets and audits are in **CAD**. Alpaca paper trades US listed securities in **USD**. Convert at execution using a free FX source (e.g., Frankfurter/ECB rates) with a fallback fixed rate in config. Store both CAD and USD amounts on every order.

---

## 7. User flows

**F1 Onboarding (once):** user opens the n8n hosted form > financial profile > weekly budgets per category > investor quiz > sees their profile, allocation tier and a plain English explanation > can edit the allocation > gives standing consent ("invest my weekly leftover automatically; I can pause anytime") > connects bank (sandbox).

**F2 During the week (automatic):** transactions sync every 6 hours. Dashboard shows each category's progress bar and "days left".

**F3 Sunday night (automatic):** audit runs > surplus computed > cushion updated > orders submitted > digest sent with compounding projection.

**F4 Monday (automatic):** reconcile order fills (orders submitted on weekends queue until market open).

**F5 Controls:** pause investing, change budgets, change cushion, retake quiz.

---

## 8. Architecture

```
            [n8n Form: onboarding]           [Next.js dashboard on Vercel]
                     |                                 | (GET/POST webhooks, header auth)
                     v                                 v
 +-------------------------------- n8n ---------------------------------+
 |  WF01 Onboarding   WF02 Plaid connect   WF03 Sync (6h)   WF03b Manual  |
 |  WF04 Weekly audit (Sun 20:00) --> WF05 Invest executor --> Alpaca     |
 |  WF06 Reconcile (hourly, weekdays)   WF07 Digest (email + LLM)         |
 |  WF08 Dashboard API   WF09 Error handler   WF00 Setup and seed         |
 |                     [ n8n Data Tables = database ]                     |
 +-----------------------------------------------------------------------+
        |                    |                     |                |
   Plaid Sandbox      Alpaca Paper API       FX rates API      LLM (Anthropic/OpenAI)
  (transactions)     (orders, positions)                       (explanations, digest)
```

---

## 9. Data model (n8n Data Tables)

Data Tables support string, number, boolean and date columns. Store JSON as a string. Data Tables are **not** included in workflow JSON exports, so WF00 creates them.

- **Date-only values** (`transactions.date`, `audits.week_start`, `audits.week_end`) are **strings** `YYYY-MM-DD`, so no timezone conversion can shift them by a day. Real moments in time (`created_at`, `filled_at`, …) use date columns.
- Data Tables don't enforce uniqueness. Workflows upsert on the keys marked unique: `users.user_id`, `profiles.user_id`, `budgets (user_id, category_key)`, `category_map (plaid_pfc_primary, plaid_pfc_detailed)`, `bank_links.item_id`, `transactions.txn_id`, `audits.audit_id`, `orders.client_order_id`, `config.key`.
- Exact column types: `contracts/data-tables.md`.

**users**: user_id (string), email, name, created_at (date), timezone, status ("active" | "paused"), consent_at (date), buffer_balance (number), buffer_target (number), cushion_rate (number), absorb_overspend (boolean), min_invest (number), max_weekly_invest (number), pending_carry (number), deficit_carry (number)

**profiles**: user_id, answers_json (string), capacity_score (number), willingness_score (number), tier (string: cash | conservative | balanced | growth | all_equity), home_bias (string), allocation_json (string, user editable), explanation (string), updated_at (date), warnings_json (string)

**budgets**: user_id, category_key, label, weekly_amount (number), active (boolean)

**category_map**: plaid_pfc_primary, plaid_pfc_detailed, category_key, excluded (boolean). Lookup: exact (primary, detailed) match first, then the row with that primary and an empty `plaid_pfc_detailed`; an unmapped primary falls back to `other`. Excluded rows use `category_key = "excluded"`.

**bank_links**: user_id, item_id, access_token (string; sandbox only, flag as a production risk), cursor (string), institution_name, linked_at

**transactions**: txn_id (string, unique), user_id, date (string YYYY-MM-DD), amount (number, CAD), merchant, pfc_primary, pfc_detailed, category_key, pending (boolean), pending_txn_id, source ("plaid" | "manual" | "seed"), removed (boolean), synced_at

**audits**: audit_id (string = user_id + week_start), user_id, week_start (string YYYY-MM-DD, a Monday), week_end (string YYYY-MM-DD), lines_json (string: per category planned/actual/under/over), gross_surplus, total_over, late_adj, to_buffer, buffer_after, investable_cad, pending_carry_after, status ("computed" | "invested" | "carried" | "skipped_paused"), created_at

**orders**: client_order_id (string, unique), audit_id, user_id, symbol, sleeve (equity_us | equity_intl | equity_ca | bonds | cash), notional_usd, notional_cad, fx_rate, alpaca_order_id, status, filled_qty, filled_avg_price, submitted_at, filled_at

**config**: key, value (string). Keys:
- `fx_fallback_usdcad`: CAD per 1 USD, used only if the FX API fails.
- `assumed_returns`: `"0.04,0.06,0.08"`.
- `demo_mode`: `"true"` or `"false"`.
- `alpaca_base_url`, `plaid_base_url`.
- `sleeve_symbols`: JSON, sleeve → ticker (§11.5). This is the "mapping is a table" from the production note.
- `demo_email_to`: if set, the demo user's digest goes here.
- `dashboard_url`: linked from the onboarding result page and the digest.

---

## 10. n8n workflows (spec)

Naming: `LO-00 Setup and Seed`, etc. Each scheduled workflow = Schedule Trigger + Webhook Trigger (POST, header auth) merged into the same logic.

### WF00 Setup and Seed
- Trigger: Manual.
- Creates all Data Tables (Data Table node, create operation) if missing. Seeds `category_map`, `config`, and one demo user "Maya" with budgets, a balanced profile, and 4 weeks of transactions from `demo/seed-data.json` (embed seed in a Code node or fetch from a raw GitHub URL).
- Also exposes webhook `POST /lo/demo/reset` to wipe and reseed (dashboard "Reset demo" button).

### WF01 Onboarding Form
- Trigger: **n8n Form Trigger** (multi page with Form nodes).
- Page 1 Financial profile, Page 2 Weekly budgets, Page 3 Investor quiz (section 11), Page 4 Result + edit allocation + consent checkbox.
- Logic: Code node computes scores > tier > allocation (section 11.3). LLM node writes a 3 to 4 sentence plain-language explanation using general, non-advisory language. Write users, budgets, profiles. Final page shows result and a link to the dashboard.

### WF02 Plaid Connect (Sandbox)
- Trigger: Webhook `POST /lo/plaid/connect-sandbox` (button on dashboard).
- HTTP: Plaid `/sandbox/public_token/create` (institution e.g. First Platypus Bank, products ["transactions"], use the dynamic transactions test user per Plaid docs) > `/item/public_token/exchange` > store access_token + item_id in bank_links > call WF03.
- This avoids building Plaid Link UI for the demo. Production would use Plaid Link.

### WF03 Transaction Sync
- Triggers: Schedule every 6 hours + Webhook `POST /lo/sync`.
- For each bank_link: HTTP `/transactions/sync` with stored cursor, loop while `has_more`. Handle added / modified / removed. Map PFC to category via category_map (Code node). Upsert by txn_id. Save new cursor.
- Demo helper: Webhook `POST /lo/demo/add-txn` calls Plaid `/sandbox/transactions/create` (custom merchant + amount), then `/transactions/refresh`, then runs the sync. Lets the presenter "buy a $14 lunch" live.

### WF03b Manual Expense
- Trigger: n8n Form "Log a purchase" (amount, category, merchant, date) + Webhook `POST /lo/expense`.
- Writes a transaction with source "manual". Fallback if Plaid is down during demo.

### WF04 Weekly Audit (core)
- Triggers: Schedule (cron Sunday 20:00, timezone America/Vancouver) + Webhook `POST /lo/audit/run` body `{user_id?, week_start?}` (defaults: all active users, current week).
- Steps per user:
  1. If status = paused: write audit with status skipped_paused, stop.
  2. Fetch budgets, this week's transactions, last week's transactions and last week's audit.
  3. Re-audit last week (6.6) > late_adj.
  4. Compute per category under/over, gross_surplus (6.4).
  5. Apply cushion (6.5), carries and caps (6.7).
  6. Write the audit row (idempotent on audit_id). An audit is **final once it moves money** (`computed`, `carried` or `invested`): a rerun of that week writes nothing and returns the stored row. If the stored audit is `computed` and the run invests, WF05 is retried with the stored amount (a backfilled week, or a failed invest). A `skipped_paused` row moved no money, so it is recomputed. Later changes to an audited week reach the next week through `late_adj` (6.6). Why not recompute: the audits table has no "balance before" columns, so a recompute couldn't undo the first run's effect on the buffer and carries.
     WF04 owns `pending_carry` and `deficit_carry`. When it invests, the old `pending_carry` is already inside `investable_cad`, so it sets `pending_carry = 0` before calling WF05.
  7. If investable >= min_invest: Execute Workflow WF05 with `{audit_id, user_id, investable_cad}`. Else status "carried".
  8. Execute WF07 digest (or let WF07 run after WF05 returns).
- All math in one Code node with unit-testable pure functions; include the worked example (6.8) as an inline self-test that throws if wrong.

### WF05 Invest Executor
- Trigger: Execute Workflow Trigger (called by WF04) + Webhook for testing.
- Steps:
  1. Load allocation_json from profile.
  2. Get USD/CAD rate (HTTP to FX API; fallback config value).
  3. Split investable into sleeves by weights; round to cents; fold any sleeve under **USD 1** (Alpaca's minimum notional for fractional orders, compared after FX conversion) into the largest sleeve.
  4. For each sleeve: Alpaca `POST /v2/orders` with `{symbol, notional, side:"buy", type:"market", time_in_force:"day", client_order_id}`. Headers `APCA-API-KEY-ID`, `APCA-API-SECRET-KEY`. Base URL `https://paper-api.alpaca.markets`.
  5. If Alpaca returns duplicate client_order_id, treat as success (idempotent).
  6. Write orders rows; set audit status "invested". Carries belong to WF04 (WF04 step 6): WF05 only clamps `pending_carry = max(pending_carry − invested, 0)`, which is a no-op after WF04 has zeroed it.
- Before first run, verify each symbol is `fractionable: true` via `GET /v2/assets/{symbol}`.

### WF06 Order Reconcile
- Triggers: Schedule hourly **06:00–14:00 America/Vancouver, Monday to Friday** (cron `0 6-14 * * 1-5`, 45 runs a week; US market hours are 06:30–13:00 Pacific, and nothing changes outside them, R3) + Webhook.
- If Alpaca is unusable, it returns `UPSTREAM_ERROR` and changes nothing. It doesn't throw, so the hourly schedule doesn't spam WF09.
- For orders not in a terminal state: `GET /v2/orders/{id}` (or by client_order_id) > update status, filled_qty, filled_avg_price, filled_at. Rejected orders: retry once as a new order with suffix `-r1`, then alert via WF09.

### WF07 Weekly Digest
- Trigger: called after audit + Webhook `POST /lo/digest/send`.
- Builds: category scoreboard, this week invested (CAD), buffer status, lifetime invested, portfolio value (derived from the user's orders, as in WF08), illustrative future value of this week's amount at 4/6/8% over 10/20/30 years: `FV = amount x (1 + r)^years`.
- LLM node writes a warm 80 to 120 word summary. Prompt rules: no recommendations to buy/sell specific securities, call projections "illustrative, not a prediction", mention the best category this week.
- Send via Gmail node (P0) or Telegram (P1).

### WF08 Dashboard API
- Webhook endpoints (header auth `x-lo-key`), each ends in Respond to Webhook with JSON:
  - `GET /lo/api/summary?user_id=` current week lines, days left, buffer, lifetime invested, portfolio value
  - `GET /lo/api/audits?user_id=` weekly history
  - `GET /lo/api/portfolio?user_id=` positions + orders. Positions are **derived from the user's own `orders` rows** (filled qty, cost basis, contributions), because every user shares one paper account and `GET /v2/positions` can't be split per user. Alpaca supplies only the latest trade price (IEX feed) and the market clock.
  - `GET /lo/api/projection?user_id=&rate=` lifetime contributions + projections
  - `POST /lo/api/settings` update budgets, pause, cushion
- Note: on n8n Cloud each webhook call counts as an execution. Dashboard must not poll; fetch on page load and on button press only.

### WF09 Error Handler
- Error Trigger. Set as the error workflow on all other workflows. Sends an email with workflow name, node, error message, execution link.

---

## 11. Investor profile quiz, scoring, portfolios

### 11.1 Financial profile questions
1. Age range
2. Income type (salaried, hourly, freelance/variable, student)
3. Monthly take home (range)
4. Pay frequency
5. Emergency fund: how many months of expenses saved (0, <1, 1 to 3, 3 to 6, 6+)
6. Any debt with interest above 8% (credit card, etc.)? Y/N
7. Account you'd hold this in (TFSA, RRSP, FHSA, non-registered, not sure). Informational, shown on dashboard.

### 11.2 Investor questions
8. Main goal (retirement, house, long term wealth, no specific goal)
9. When might you need this money? (<3y, 3 to 5, 5 to 10, 10 to 20, 20+)
10. Your portfolio drops 30% in a year. You: sell everything / sell some / hold / buy more
11. Largest one year drop you could live with: 5 / 10 / 20 / 30 / 40%+
12. Investing experience (none, some, experienced)
13. How stable is your income? (very, somewhat, not)
14. Geographic preference: more Canada / global market weight / no preference
15. ESG preference (P2; only if verified fractionable tickers exist)

### 11.3 Scoring
- **Capacity score** (0 to 100) from horizon (Q9, heaviest), income stability (Q13), emergency fund (Q5).
- **Willingness score** (0 to 100) from Q10, Q11, Q12.
- Tier from each score: 0 to 19 cash, 20 to 39 conservative, 40 to 59 balanced, 60 to 79 growth, 80+ all_equity.
- **Final tier = the lower of the two.** Hard rule: horizon < 3 years forces cash.
- User sees the result, why, and can change it (an editable allocation keeps the tool self-directed rather than a recommendation).

### 11.4 Warnings (education, not advice)
- Emergency fund 0 or <1 month: show "Many people build a cash cushion first" and suggest raising buffer_target.
- High-interest debt = yes: show "Paying off debt above 8% is a guaranteed return many people prioritize" and allow the user to continue. (P2: a "debt mode" that tracks surplus as debt paydown instead of investing.)

### 11.5 Portfolios (asset allocation)
| Tier | Equity | Bonds | Cash |
|---|---|---|---|
| cash | 0 | 0 | 100 |
| conservative | 20 | 60 | 20 |
| balanced | 60 | 40 | 0 |
| growth | 80 | 20 | 0 |
| all_equity | 100 | 0 | 0 |

Equity sleeve split by home bias: global market weight = US 60 / Intl 35 / Canada 5; more Canada = US 45 / Intl 25 / Canada 30.

**Demo ticker mapping (Alpaca paper, US listed, verify fractionable):**
- equity_us: VTI, equity_intl: VXUS, equity_ca: EWC, bonds: BND, cash: SGOV (US T-bill ETF)

**Production note (for pitch, not built):** a Canadian product would hold Canadian listed equivalents (all-in-one asset allocation ETFs, HISA/money market ETFs) through a registered Canadian dealer. The mapping is a table so this is a config change, not a rewrite.

---

## 12. Execution details and gotchas (Alpaca)

- **Paper accounts are open to anyone globally with an email.** API access is identical to live, without real money.
- **Only US listed stocks/ETFs**, priced in USD (hence the FX step and US proxies).
- **Fractional/notional orders**: market, `time_in_force: day`. Orders submitted outside market hours queue for the next session.
- **WEEKEND DEMO GOTCHA:** the audit runs Sunday and hackathons run on weekends, so orders will show as accepted/queued, not filled. Dashboard must show "Queued, fills at Monday's open" and an estimated value from the latest quote (Alpaca market data, IEX feed on paper). Do not let this look like a bug in the demo. Optional: if presenting on a weekday during market hours, orders fill live.
- Reset the paper account if fractional behaviour looks wrong (Alpaca docs suggest this).

---

## 13. Dashboard spec (Next.js on Vercel)

Pages:
1. **This week**: per category progress bars (planned vs actual, colour shifts as you approach the limit), days left, projected leftover if current pace holds, buffer meter.
2. **History**: table and bar chart of weekly gross surplus, to buffer, invested; filter by category; "best category" streaks.
3. **Portfolio**: positions, market value (USD and CAD), total contributed, unrealized gain, order list with status chips (queued / filled / rejected).
4. **Compounding**: lifetime contributed and projected value at 10/20/30 years with a 4/6/8% toggle. "Your choices" list: "Eating out under budget 5 of 8 weeks: $74 invested, illustrative 30y value $X". Label everything illustrative.
5. **Settings**: edit budgets, pause/resume, cushion settings, retake quiz (link to n8n form).

Demo control bar (visible when `demo_mode = true`): Connect sandbox bank, Add sandbox purchase, Sync now, Run audit now, Send digest, Reset demo.

Env: `N8N_BASE_URL`, `N8N_WEBHOOK_KEY`, `DEMO_USER_ID`. Calls n8n from Next.js server routes so the key isn't exposed to the browser.

Disclaimer footer on every page: "Educational prototype using simulated (paper) trading. Not investment advice. Projections are illustrative."

---

## 14. Compliance framing

In Canada, investment recommendations need a registered advisor or portfolio manager. CIRO's updated guidance for order execution only platforms (March 2026) allows sample portfolios based on asset allocation, client-input risk questionnaires with general language, and tools that act strictly within client-defined parameters, while prohibiting recommendations to buy, sell or hold specific securities. Leftover is designed in that spirit: the user answers the questionnaire, sees an asset allocation tier with an explanation, can edit it, and sets the rule the automation follows. We are not a registered dealer; the prototype uses paper trading only. Say this in the pitch before a judge asks.

---

## 15. Demo script (3 minutes)

1. (20s) Problem: one stat (41% of young TFSA holders not investing) + "round-ups reward spending; we reward spending less."
2. (40s) Onboarding form: answer quiz fast, show tier + explanation + edit, consent.
3. (40s) Dashboard "This week": show Maya under budget on groceries, over on eating out. Click "Add sandbox purchase" ($14 lunch), Sync, bar moves.
4. (40s) Click "Run audit now". Show the n8n canvas executing (judges care about the workflow), then dashboard: surplus, cushion, orders queued.
5. (30s) Show the digest email with compounding line: "This week's $13 is about $X in 30 years at 6% (illustrative)."
6. (10s) Close: architecture slide of the 10 workflows.

Backup: if Plaid fails, use the manual expense form. If Alpaca fails, the audit still shows the computed split. Record a screen capture of a full successful run beforehand.

---

## 16. Setup guide

### 16.1 n8n
**Option A (recommended for the hackathon): n8n Cloud free trial.** 14 days, Pro features, 1,000 executions, no card. Gives public webhook URLs for the Vercel dashboard immediately. Export all workflows as JSON before the trial ends (you get 90 days to download afterwards). Watch the execution count: syncs, audits and every dashboard webhook call each count.

**Option B: local Docker (free, unlimited).**
```bash
docker volume create n8n_data
docker run -it --rm --name n8n -p 5678:5678 \
  -e GENERIC_TIMEZONE="America/Vancouver" -e TZ="America/Vancouver" \
  -v n8n_data:/home/node/.n8n \
  docker.n8n.io/n8nio/n8n
```
Open http://localhost:5678 and create the owner account. For public webhooks during dev add `start --tunnel` at the end (dev only) or use cloudflared/ngrok. Without Docker: `npx n8n`.

**What this build actually uses for dev:** no Docker on Sergio's Mac, so n8n runs with `npx n8n@<pinned version>` (Node 26), with `GENERIC_TIMEZONE` and `TZ` set to America/Vancouver. The pinned version and how to start it live in `n8n/CONVENTIONS.md`. The demo instance (Cloud trial or tunnel) is set up in Wave 3 by importing the same JSON.

Either way: set the instance timezone to America/Vancouver, set WF09 as the error workflow everywhere.

**Importing:** Workflows > menu > Import from File (or paste JSON on the canvas). Self-hosted CLI: `n8n import:workflow --input=file.json`. After import, open each HTTP/credential node and select the credential, then activate.

### 16.2 Credentials to create in n8n
| Name | Type | Values |
|---|---|---|
| `Alpaca Paper` | Custom Auth (both headers) | APCA-API-KEY-ID, APCA-API-SECRET-KEY |
| `Plaid Sandbox` | Custom Auth that injects `client_id` + `secret` into the JSON body (never store them in workflow JSON or Data Tables) | client_id, sandbox secret |
| `LLM` | Anthropic or OpenAI credential | API key |
| `Gmail` | Gmail OAuth2 | your account |
| `LO Webhook Key` | Header Auth | `x-lo-key: <random 32 chars>` |

### 16.3 Accounts
1. **Alpaca**: sign up at alpaca.markets > Paper account > generate paper API keys.
2. **Plaid**: sign up at dashboard.plaid.com > get Sandbox client_id and secret. Sandbox base URL `https://sandbox.plaid.com`.
3. **LLM**: Anthropic or OpenAI API key.
4. **Vercel**: import `dashboard/`, set env vars, deploy.

### 16.4 Claude Code loop
1. Wave 1 (P0) scaffolds the repo, locks `contracts/`, seeds data and creates a stub for every workflow. See `BUILD-PLAN.md`.
2. Wave 2 runs one Claude Code session per lane in parallel. Each lane pushes its workflow JSON into the running n8n with `scripts/n8n.mjs` (n8n's CLI: import + publish, no API key), tests it through its webhook, and commits. Workflows have fixed IDs (`n8n/ids.json`).
3. After any fix made in the n8n UI, pull the workflow back into the repo (`scripts/n8n.mjs pull`) so the repo matches what runs.
4. Wave 3 (Z) wires the workflows together, imports everything into a fresh instance and rehearses the demo.

---

## 17. Build plan (solo + Claude Code)

| # | Milestone | Done when |
|---|---|---|
| M1 | n8n running, credentials set, WF00 seeds Maya | Data Tables visible with 4 weeks of data |
| M2 | WF04 audit on seed data | Manual run writes correct audit; self-test passes |
| M3 | WF05 + WF06 Alpaca | Orders appear in Alpaca paper dashboard; rerun creates no duplicates |
| M4 | WF08 API + dashboard pages 1 to 3 | Dashboard shows week, history, portfolio from live n8n |
| M5 | WF01 onboarding form | New user can onboard end to end |
| M6 | WF02 + WF03 Plaid sandbox | Sandbox purchase appears in dashboard after sync |
| M7 | WF07 digest + compounding page | Email arrives with projection |
| M8 | Demo polish, WF09, recording, README | Full demo script runs twice in a row cleanly |

If time runs short, cut in this order: ESG option, Telegram, debt mode, Plaid (fall back to seed + manual form). Never cut M2/M3.

---

## 18. Risks and open decisions

**Risks**
- R1 Weekend market closure makes orders look stuck. Mitigation: queued state + estimate (section 12).
- R2 n8n JSON/node version mismatch. Mitigation: target the installed version; re-export after fixes.
- R3 Cloud trial execution cap (1,000). Mitigation: no polling, 6h sync, or switch to Docker.
- R4 Gross per-category investing can invest money on a week that was net over budget. Mitigation: overspend drains cushion (D2).
- R5 Regulatory perception. Mitigation: section 14 framing, editable allocation, disclaimers.
- R6 Plaid sandbox setup takes longer than expected. Mitigation: manual form + seed data.

**Decisions** (defaults adopted 2026-11-14; if Sergio decides otherwise, change them here first)
- D1 Product name: keep "Leftover" in code for now; rename user-facing strings in Wave 3.
- D2 Overspend drains the cushion: **ON** (`absorb_overspend = true`).
- D3 Digest channel: **email only**. Telegram stays P1.
- D4 LLM provider: **open**, whichever the hackathon gives credits for. The credential is always named `LLM`; the chosen provider is recorded in `n8n/CONVENTIONS.md`.
- D5 Cushion defaults: **$100 target, 50% rate**.

---

## 19. Locked conventions

Frozen for the parallel build: every lane codes against this section. The exact JSON lives in `contracts/`; if the two disagree, this section wins.

### 19.1 Workflows and routes
Workflow names run `LO-00 Setup and Seed` … `LO-09 Error Handler` (WF03b is `LO-03b Manual Expense`). Every workflow exists in n8n from Wave 1 on, as a stub until its lane fills it in, so **workflow IDs never change**.

All routes need the header `x-lo-key` (credential `LO Webhook Key`).

| Route | Workflow | Body / query |
|---|---|---|
| `POST /lo/demo/reset` | LO-00 | `{}`. Deletes and reseeds the demo user's rows only. |
| `POST /lo/plaid/connect-sandbox` | LO-02 | `{user_id}` |
| `POST /lo/sync` | LO-03 | `{user_id?}` (default: every linked user) |
| `POST /lo/demo/add-txn` | LO-03 | `{user_id, merchant, amount_cad, date?}` |
| `POST /lo/expense` | LO-03b | `{user_id, amount_cad, category_key, merchant, date?}` |
| `POST /lo/audit/run` | LO-04 | `{user_id?, week_start?, invest?}`. `invest` defaults to `true`; `false` writes the audit without calling LO-05 (for backfills). |
| `POST /lo/invest/run` | LO-05 | `{audit_id, user_id, investable_cad, dry_run?}` (test entry, same as the internal call) |
| `POST /lo/reconcile/run` | LO-06 | `{user_id?}` (default: every open order; `user_id` is for testing) |
| `POST /lo/digest/send` | LO-07 | `{user_id, audit_id?, dry_run?}` (default: latest audit) |
| `GET /lo/api/summary` | LO-08 | `?user_id=` |
| `GET /lo/api/audits` | LO-08 | `?user_id=` |
| `GET /lo/api/portfolio` | LO-08 | `?user_id=` |
| `GET /lo/api/projection` | LO-08 | `?user_id=&rate=`. The response carries all three rates (0.04, 0.06, 0.08), so the dashboard toggle needs no extra call; `rate` only sets `selected_rate` (default 0.06). |
| `POST /lo/api/settings` | LO-08 | `{user_id, budgets?, status?, buffer_target?, cushion_rate?, absorb_overspend?}` |

LO-01 is an n8n Form with its own URL. LO-09 has no route.

**Internal calls** (Execute Workflow):
- LO-04 → LO-05 `{audit_id, user_id, investable_cad}`
- LO-04 → LO-07 `{user_id, audit_id}`
- LO-02 → LO-03 `{user_id}`

### 19.2 Response format
- Success: `{"ok": true, "data": {...}}`. Failure: `{"ok": false, "error": {"code": "SNAKE_CASE", "message": "..."}}` with a 4xx/5xx status.
- **Money:** numbers in dollars rounded to cents. API field names end in `_cad` or `_usd`. (Data Table columns keep their §9 names.)
- **Dates:** `YYYY-MM-DD`. Timestamps: ISO 8601 with offset. A week is identified by its Monday, `week_start`, in America/Vancouver.
- **IDs:** `audit_id = {user_id}-{week_start}` (e.g. `maya-2026-11-09`). `client_order_id = {audit_id}-{symbol}`; the retry suffix is `-r1`.
- **Order status:** the `orders.status` column stores Alpaca's raw status. The API maps it to one of `queued | partially_filled | filled | rejected | canceled`:
  - `filled`, `partially_filled` and `rejected` keep their names;
  - `canceled` and `expired` become `canceled`;
  - everything else (`new`, `accepted`, `pending_new`, …) is `queued`.

### 19.3 Users
- Demo user: `maya`. Test users: `test-a` … `test-f`, one per build lane. Lanes write test data only under their own test user.
- `POST /lo/demo/reset` touches only `maya`.
- `user_id` values are lowercase, URL-safe slugs.

### 19.4 Seed data
`demo/seed-data.json` stores transaction dates as `day_offset` from the current week's Monday (0 = this Monday, -7 = last Monday). LO-00 turns them into real dates at seed time with `seedDate()` from `lib/week.mjs`, clamping any date after today to today, so whenever the demo runs there's always a live "this week" plus 3 past weeks. The seed's `_expected` block holds the audit results a correct implementation must produce (checked by `scripts/seed.test.mjs`).

### 19.5 When an outside service is missing or down
The demo must never break (§15 backup plan), and lanes build before every credential exists.
- `POST /lo/invest/run` and `POST /lo/digest/send` accept **`dry_run: true`**. Invest computes FX and the sleeve split and returns the orders it *would* place (status `dry_run`), without calling Alpaca or writing rows. Digest returns `subject` and `body` without sending.
- If Alpaca is unreachable or the `Alpaca Paper` credential is missing, LO-05 behaves like `dry_run` and returns `error.code = "UPSTREAM_ERROR"` alongside the computed split. The audit stays `computed`, so a later run can still invest.
- Without Alpaca, LO-08 and LO-07 value positions at the last fill price and return `market_open: null`, `next_open: null` (the dashboard says market hours are unavailable). LO-06 returns `UPSTREAM_ERROR` and changes nothing.
- If the LLM fails, LO-01 and LO-07 fall back to a fixed template text (still general, non-advisory language), so the form and the digest always complete.
- If Plaid is missing, LO-03b (manual expense) and the seed carry the demo (§15).

### 19.6 Code
- Pure logic lives in `lib/*.mjs`: plain functions, no imports, no npm packages, tested with `node --test`, then pasted verbatim into Code nodes.
- Week math (Monday start, America/Vancouver) comes from `lib/week.mjs` only.
- Workflow JSON is built from `n8n/templates/node-snippets.json` (exported from the pinned n8n version), never from guessed `typeVersion`s.

---

## 20. Sources
- Qapital Spend Less Rule: https://help.qapital.com/en/articles/10245398-spend-less-rule
- Wealthsimple Roundup: https://www.iphoneincanada.ca/deals/wealthsimple-roundup/
- Moka review and pricing: https://money.ca/investing/reviews/moka
- KOHO RoundUps / Canadian micro-investing: https://loanscanada.ca/investing/best-micro-investing-apps-in-canada/
- TD TFSA survey (Nov 2025): https://stories.td.com/ca/en/news/2025-11-12-risking-no-returns-3f-4-in-10-young-canadians-missing-out-on-t
- Global News on TD survey: https://globalnews.ca/news/11522732/tax-free-savings-account-young-canadians
- TD Gen Z financial stress survey (Oct 2025): https://stories.td.com/ca/en/news/2025-10-14-more-than-half-of-gen-z-canadians-feel-pressured-to-27fake-27-f
- National Payroll Institute via BNN Bloomberg: https://www.bnnbloomberg.ca/investing/opinion/2025/09/12/gen-z-leads-canadians-saving-more-and-worrying-less-about-their-finances-dale-jackson/
- CIRO OEO guidance summary (TD Securities): https://www.tdsecurities.com/ca/en/ciro-guidance-for-oeo-sample-portfolios
- CIRO primer with March 12, 2026 guidance date (BLG): https://www.blg.com/insights/2023/ri/understanding-the-canadian-investment-regulatory-organization-ciro-a-quick-primer
- Alpaca account plans (paper open globally): https://alpaca.markets/deprecated/docs/trading-on-alpaca/account-plans
- Alpaca fractional trading: https://docs.alpaca.markets/docs/fractional-trading
- Alpaca orders (outside hours queueing): https://docs.alpaca.markets/docs/trading/orders/
- Plaid Transactions + sandbox test users: https://plaid.com/docs/transactions/
- Plaid Transactions API: https://plaid.com/docs/api/products/transactions/
- n8n Data Tables: https://docs.n8n.io/data/data-tables/ and https://docs.n8n.io/build/work-with-data/data-tables
- n8n export/import: https://docs.n8n.io/build/manage-workflows/export-and-import
- n8n Docker: https://hub.docker.com/r/n8nio/n8n
- n8n Cloud trial: https://docs.n8n.io/deploy/use-n8n-cloud/start-your-free-trial
