# Devpost submission text

Paste each section into the matching Devpost field. Lines marked **FILL IN** need you.

## Project name
Leftover

## Tagline
Invest what you didn't spend: a Sunday n8n workflow turns your unspent weekly budget into an ETF portfolio.

## Tracks
n8n Track, Investly Finance Track, and the overall prize.

## Team
**FILL IN:** names of everyone on the team.

## Links
- Repo, with the 11 n8n workflow exports in `n8n/workflows/`: https://github.com/danieldalopez/leftover
- Dashboard: https://leftover-rosy.vercel.app
- Video: **FILL IN** the YouTube or Vimeo link after uploading `demo/leftover-demo.mp4`

## The problem
Young Canadians are saving but not investing. In a TD survey (October 2025, n=1,500), 41% of Gen Z and Millennial Canadians with a TFSA weren't investing the money in it, and 22% of those said they didn't have enough saved to start. The saving habit is there; the step from "cash left in chequing" to "invested" is missing.

Round-up apps tie investing to spending more. Leftover ties it to spending less.

## What it does
You set a weekly budget per category (groceries, eating out, transport and so on). Every Sunday at 8 pm an n8n workflow audits what you actually spent:

1. Each category's unspent budget is added up. Categories aren't netted against each other, so overspending on eating out doesn't erase what you saved on groceries.
2. Overspending comes out of a cash cushion, and a share of the leftover refills it.
3. The rest is split across an ETF mix that matches your risk profile and placed as paper orders.
4. A digest email shows the week and what this week's leftover could grow into over 10, 20 and 30 years (labelled illustrative).

An onboarding form scores your capacity and willingness to take risk, suggests a mix you can edit, and asks for standing consent before anything is invested. A dashboard shows this week, the history, the portfolio and the compounding view, and lets you change the rules or pause.

## How we built it
n8n is the whole backend: 11 workflows, with n8n Data Tables as the database.

- **Onboarding** is an n8n multi-page form.
- **Bank data** comes from Plaid's sandbox every 6 hours, with a manual-expense route as backup.
- **The weekly audit** runs on a schedule, then calls the invest workflow and the digest workflow as sub-workflows.
- **Investing** places fractional paper orders on Alpaca; a reconcile workflow updates fills on weekdays.
- **A dashboard API** workflow serves the Next.js dashboard, which only calls n8n webhooks.
- **An error workflow** catches failures from all of the others.

The money logic (audit, cushion, allocation, scoring) is plain JavaScript with 195 tests, pasted verbatim into the n8n Code nodes, and a test fails if a copy drifts. Every external service has a documented fallback, so the pipeline finishes even when one is down.

## What works today, and what doesn't
- Working end to end on a self-hosted n8n: onboarding, budgets, manual expenses, the audit, the cushion, the allocation split, the digest text, the dashboard, and the error workflow.
- Built but running on its fallback in the demo, because the keys aren't connected: Alpaca orders (the split is computed, no orders are sent), Plaid sync (purchases are logged by hand), and Gmail (the email is built, not sent).
- All trading is simulated (paper). This is an educational prototype, not investment advice.

## What's next
- Connect Alpaca, Plaid and Gmail so the fallbacks become the real steps.
- A human-in-the-loop approval before the first few investments.
- Plain-language explanations written by an LLM (the nodes are in the workflows, switched off).
- Real accounts: TFSA and FHSA support through a Canadian broker.

## Built with
n8n (self-hosted 2.47.7: Data Tables, Forms, schedules, webhooks, sub-workflows), JavaScript, Next.js, React, TypeScript, Vercel, Alpaca paper trading API, Plaid sandbox, Frankfurter FX API, Gmail, localhost.run (tunnel), Google Fonts (Jersey 15).

## Outside services, models and templates
- Services: the ones listed above.
- Models: none inside the product. Claude Code was used as a coding assistant to build it.
- Templates: **FILL IN / confirm** none. The workflows were built from scratch.
