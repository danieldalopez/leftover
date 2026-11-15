# Demo script (3 minutes)

From spec §15. Each step says what to click, what to say, and what to do if a service is missing. Rehearse with `node scripts/demo-rehearsal.mjs --twice`, which runs these exact steps against the live routes and ends with a reset.

## Before you go on stage (10 minutes before)
- [ ] n8n running (preview server `leftover-n8n`, or the command in `n8n/README.md`). The owner account is created, so you can show the canvas.
- [ ] Dashboard open: https://leftover-rosy.vercel.app (needs the preview server `leftover-public` running: it tunnels the webhooks and re-points Vercel), or local at http://localhost:3211. The badge must say **Live from n8n**, not "Mock data".
- [ ] Tab 2: the n8n canvas, LO-04 Weekly Audit open (that's the one judges watch run).
- [ ] Tab 3: the onboarding form, `<n8n URL>/form/lo-onboarding`.
- [ ] `node scripts/demo-rehearsal.mjs`: all ✓ or ↷. It finishes with a reset, so Maya starts clean.
- [ ] Credentials connected so far (each one makes a step real instead of a fallback): Alpaca, Plaid, Gmail. There's no LLM on purpose (spec D4): the texts are fixed templates.
- [ ] Backup video at hand: `demo/leftover-demo.mp4`. Re-record it after connecting a credential (`node demo/record-demo.mjs`), so it shows the real step instead of the fallback.

## The 3 minutes

**1. Problem (20 s)**
Say: 41% of young TFSA holders aren't investing. Round-up apps reward spending. Leftover rewards spending *less*: every Sunday, whatever you didn't spend in each budget category gets invested.

**2. Onboarding (40 s)**: tab 3, the form.
Answer the quiz fast, then show the tier, the plain-language explanation, the editable allocation and the consent box.
The explanation is template text written from their own answers: tier, horizon, how big a drop they'd sit through, home bias. There's no LLM (spec D4).

**3. This week (40 s)**: dashboard, "This week".
Point out Maya: under budget on groceries, over on eating out (red bar). Click **Add sandbox purchase** ($14 Banh Mi) and the eating-out bar moves.
- With Plaid: the purchase is created in Plaid's sandbox and synced. Click **More → Sync now** if it hasn't landed.
- Without Plaid: the result says it failed and offers **"Log it as a manual expense instead"**. Click it and the bar moves the same way. Say: "if the bank feed is down, a purchase can be logged by hand."

**4. Run the audit (40 s)**: click **Run audit now**, then switch to tab 2.
Show LO-04's execution: audit, then invest (LO-05), then digest (LO-07). Back on the dashboard, show the leftover, the cushion top-up and the orders.
- With Alpaca: "invested $X". Portfolio shows the orders; on a weekend they're **Queued · fills at Monday's open**, and that's expected (spec §12).
- Without Alpaca: "$X ready to invest, not invested (Alpaca not connected)". Say: "the split is computed; with the broker connected these become paper orders." The audit stays open, so a later run can invest it. History shows the week as "$X ready".

**5. The digest (30 s)**: click **Send digest**.
- With Gmail: open the email. Read the compounding line: "Illustrative, not a prediction: at 6% a year, this week's $X could grow to about $Y in 30 years."
- Without Gmail: the result says "Digest built … (not sent)". Expand **Response** under it; the subject and body are there.

**6. Close (10 s)**: the architecture slide with the 11 workflows. n8n is the whole backend: Data Tables, schedules, Alpaca and Plaid calls, email and the error alerts.

## Reset between runs
Click **More → Reset demo** (it asks to confirm). Maya is reseeded and her 3 past weeks are re-audited, so History isn't empty. From a terminal: `node scripts/n8n.mjs call POST lo/demo/reset '{}'`.

## If something breaks on stage
| Symptom | Do this |
|---|---|
| Badge says "Mock data" | n8n is down or unreachable: restart it, reload the page |
| A button hangs | The audit chain can take a few seconds. Show the n8n canvas while it runs |
| Wrong numbers after an earlier run | Reset demo |
| Everything is down | Play `demo/leftover-demo.mp4` |
