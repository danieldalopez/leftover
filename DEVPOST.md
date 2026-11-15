# Devpost submission text

Paste each section into the matching Devpost field. Lines marked **FILL IN** need you.

## Project name
Leftover

## Tagline
Invest what you didn't spend. Every Sunday, an n8n workflow audits your week and invests the leftover.

## Tracks
n8n Track, Investly Finance Track, and the overall prize.

## Team
**FILL IN:** names of everyone on the team.

## Links
- Repo, with the 11 n8n workflow exports in `n8n/workflows/`: https://github.com/danieldalopez/leftover
- Dashboard: https://leftover-rosy.vercel.app
- Video: **FILL IN** the YouTube or Vimeo link after uploading `demo/leftover-demo.mp4`

## Inspiration
Young Canadians are saving but not investing. In a TD survey (October 2025, n=1,500), 41% of Gen Z and Millennial Canadians with a TFSA weren't investing the money in it, and 22% of those said they didn't have enough saved to start. The saving habit is there. What's missing is the step from "cash left in chequing" to "invested".

Round-up apps tie investing to spending more. We wanted the opposite: you invest because you chose to spend less.

## What it does
You set a weekly budget per category (groceries, eating out, transport and so on). Every Sunday at 8 pm an n8n workflow audits what you actually spent:

1. Each category's unspent budget is added up. Categories aren't netted against each other, so overspending on eating out doesn't erase what you saved on groceries.
2. Overspending comes out of a cash cushion, and a share of the leftover refills it.
3. The rest is split across an ETF mix that matches your risk profile and goes out as paper orders.
4. A digest shows your scoreboard and what this week's leftover could grow into over 10, 20 and 30 years.

The person stays in the loop. An onboarding form scores capacity and willingness to take risk and suggests a mix you can edit. Nothing is invested without standing consent. The dashboard lets you change budgets, change the cushion rules, or pause the automation at any time.

## How we built it
**n8n is the whole backend:** 11 workflows, with n8n Data Tables as the database.

- Onboarding is an n8n multi-page form.
- Bank transactions sync from Plaid's sandbox every 6 hours, and a purchase can also be entered directly.
- The weekly audit runs on a schedule, then calls the invest workflow and the digest workflow as sub-workflows.
- The invest workflow places fractional paper orders on Alpaca. A reconcile workflow updates fills on weekdays.
- A dashboard API workflow serves a Next.js dashboard that only calls n8n webhooks.
- An error workflow catches failures from all the others.

**Built with AI, from a written spec.** We wrote one spec and froze the contracts (table schemas, webhook routes, JSON shapes). Six Claude Code sessions then built the workflows in parallel, each owning one lane (audit, invest, bank data, onboarding, API and digest, dashboard), and a final session integrated them. The spec, the build plan and each lane's notes are in the repo.

**AI builds it; rules move the money.** Anything that decides how much is invested is plain, deterministic JavaScript with 195 tests, pasted verbatim into the n8n Code nodes, and a test fails if a copy drifts. The language-model steps (the plain-language risk explanation and the digest summary) are wired into the workflows behind a validator that rejects tickers, advice and unlabelled projections, with a template as the default. For a product that touches money, that order felt right: predictable first, generative on top.

## Challenges we ran into
- **Parallel AI sessions stepping on each other.** Solved by freezing contracts first and giving every workflow a fixed ID, so a workflow could call another before it existed.
- **n8n Code nodes can't import shared code.** Solved by keeping the logic in tested files and pasting it verbatim, with tests that catch drift.
- **A timezone change mid-build.** British Columbia moved to permanent UTC−7 on November 1, 2026, and Node's bundled timezone data didn't know yet, so "Sunday 8 pm" fired an hour late. We shipped newer timezone data with the project.
- **Every external service needs a safe path.** Each one has a defined behaviour when it isn't reachable, so the Sunday run always finishes.

## Accomplishments that we're proud of
- A complete pipeline on n8n: form, bank data, audit, cushion, allocation, orders, reconciliation, digest, dashboard API and error handling.
- The audit handles the awkward cases: refunds, late-posting charges, carry-overs below the minimum, a paused user.
- A fresh, empty n8n goes from zero to a working demo with one setup command and one reset call.

## What we learned
Writing the spec and the contracts first is what made building with AI fast. The sessions were only as good as the rules they shared.

## What's next
- Run it against live broker, bank and mail accounts for a group of test users.
- An approval step for the first few investments, before going fully automatic.
- Turn on the language-model explanation and digest summary for everyone.
- Registered accounts: TFSA and FHSA through a Canadian broker.

## Built with
n8n (self-hosted 2.47.7: Data Tables, Forms, schedules, webhooks, sub-workflows), JavaScript, Next.js, React, TypeScript, Vercel, Alpaca paper trading API, Plaid sandbox, Frankfurter FX API, Gmail, localhost.run, Google Fonts (Jersey 15), Claude Code.

## Outside services, models and templates
- **Services:** the ones listed above.
- **Models:** Claude, through Claude Code, built the project. In the demo the product's own text comes from templates.
- **Templates:** **FILL IN / confirm** none. The workflows were built from scratch.
- All trading is simulated (paper). In the demo instance the broker, bank and mail connections run in their offline path: the audit computes the investable amount and the split, purchases are entered directly, and the digest is shown as a preview. Educational prototype, not investment advice.
