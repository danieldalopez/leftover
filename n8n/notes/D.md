# Lane D: Onboarding (LO-01)

Owner files: `n8n/workflows/01-onboarding-form.json`, `lib/scoring.mjs`, `lib/scoring.test.mjs`, this note.
Status (2026-11-14): **done**, except the LLM explanation, which runs on the template fallback until the `LLM` credential exists (spec §19.5).

## What it does
- **Form URL:** `http://localhost:5678/form/lo-onboarding` (Form Trigger path `lo-onboarding`, no auth, workflow active).
- **Pages** (spec §7 F1, §10 WF01):
  1. Financial profile: name, email, §11.1 questions 1–7.
  2. Weekly budgets: 7 number fields, prefilled with the §6.2 defaults, or with the user's current budgets when they retake.
  3. Investor quiz: §11.2 questions 8–14 (Q15 ESG is P2, not asked).
  4. Result: tier, scores, explanation, warnings, suggested mix as **5 editable percent fields**, cash cushion target, standing-consent checkbox, §14 wording + disclaimer.
  5. Done page: what was saved + link to config `dashboard_url` (shows a placeholder line while it's empty).
- **Writes** (upsert on contract keys): `users` (user_id), `profiles` (user_id), `budgets` (user_id + category_key).
- Canvas: `Page 1` → Read users → Read budgets → Identify user → `Page 2` → `Page 3` → Score answers → **Explain (LLM)** → Pick explanation → `Page 4` → Build rows → User row → Save user → Profile row → Save profile → Budget rows → Save budgets → Read dashboard URL → Done page text → Done.

## Decisions
- **Email → user_id** (`resolveUserId` in `lib/scoring.mjs`):
  1. an existing user with that email (case-insensitive) keeps their `user_id`, so retaking the quiz updates them;
  2. otherwise `user_id` = slug of the email's local part (`test-d@leftover.test` → `test-d`, `Jo.Smith@x.com` → `jo-smith`);
  3. if that id is taken by another email, or protected, a 6-hex hash of the email is appended (`test-d-1a2b3c`).
  - `maya` is protected (`LO_PROTECTED_USER_IDS`): the form never matches or overwrites her; `maya@example.com` becomes `maya-<hash>`. **Z:** if the demo should let Maya retake the quiz from Settings, remove `'maya'` from that list, then `LO_UPDATE_WF01=1 npm test` and push.
- **Scoring** (§11.3; points per answer 0–100, weighted, rounded):
  - capacity = 0.6·horizon (`<3` 0, `3-5` 20, `5-10` 40, `10-20` 60, `20+` 100) + 0.2·income stability (not 0, somewhat 50, very 100) + 0.2·emergency fund (`0` 0, `<1` 20, `1-3` 40, `3-6` 70, `6+` 100);
  - willingness = 0.4·drop reaction (sell all 0, sell some 30, hold 60, buy more 100) + 0.4·max drop (5% 0, 10% 20, 20% 40, 30% 70, 40%+ 100) + 0.2·experience (none 0, some 40, experienced 100);
  - tier per score at 20/40/60/80, final = the lower; horizon `<3` forces cash.
  - The weights were chosen so Maya's seeded answers give exactly her seeded **64 / 48 → balanced** (a test checks this).
- **Warnings** (§11.4): codes `low_emergency_fund` (fund `0` or `<1`), `high_interest_debt`, with the spec's exact text. A low fund prefills the cushion target with **$200** instead of $100 ("suggest raising buffer_target"; the $200 is my pick). Warnings never block.
- **Editable allocation:** the result page prefills the suggested mix in whole percents. What the user enters is saved to `allocation_json` (scaled to 100% if it doesn't add up; all zero/blank keeps the suggestion). `profiles.tier` stays the questionnaire's tier. **→ LO-05 must invest by `allocation_json`, not recompute from `tier` + `home_bias`** (left a note for Lane B in the shared notes folder).
- **Consent:** checkbox, not required. Ticked → `status: active`, `consent_at` = now. Unticked → `status: paused` (no `consent_at` written; a returning user's old `consent_at` stays as history).
- **Returning user:** only `email`, `name`, `status`, `buffer_target` (and `consent_at` if ticked) are written, so `buffer_balance`, `pending_carry`, `deficit_carry`, `created_at` and the cushion settings survive a retake. Budgets keep their `active` flag.
- **Answers JSON** uses the same keys and values as the seed's `profile.answers` (`high_interest_debt` is a boolean).

## LLM explanation (blocked on the `LLM` credential)
- **Explain (LLM)** is the n8n Anthropic node (`@n8n/n8n-nodes-langchain.anthropic` v1, "Message a model"), model `claude-opus-5-5`, system prompt `{{ $json.llm_system }}`, user prompt `{{ $json.llm_prompt }}`, max tokens 4000, `onError: continueRegularOutput`. It is **disabled**: a disabled node passes its input through, so **Pick explanation** finds no LLM text and uses `templateExplanation()`.
- **To turn it on (one node):** create the `LLM` credential, attach it to **Explain (LLM)**, enable the node, `pull` it back into the repo. If D4 picks OpenAI, replace this node with the OpenAI node under the same name, same two prompt expressions; **Pick explanation** already reads either node's output (`extractLlmText`).
- Don't set temperature / top_p / top_k in the node: current Claude models reject them.
- **Pick explanation** only accepts LLM text that passes `checkExplanation()`: 80–900 chars, 2–6 sentences, no ticker (VTI, VXUS, EWC, BND, SGOV), no "you should / we recommend … buy/sell/hold", no "guarantee". Otherwise, or on any LLM error or refusal, the template is used. So the form always completes.
- Not verified yet: the real Anthropic node output and a live call. Once the credential exists, run the form once and check `profiles.explanation` reads like an LLM wrote it (the done page summary doesn't say which source was used; the execution's **Pick explanation** output has `explanation_source: "llm" | "template"`).

## How to test
```bash
npm test                                   # 61 tests (lib/scoring.test.mjs + P0's), all green
node scripts/n8n.mjs push n8n/workflows/01-onboarding-form.json
```
- **In a browser:** open `http://localhost:5678/form/lo-onboarding`, use email `test-d@leftover.test`. Prefill name and email with `?name=Dana&email=test-d%40leftover.test` (the dashboard's "Retake quiz" link can do the same with the user's email).
- **Over HTTP (what I ran):** the form protocol is: POST `multipart/form-data` to `/form/lo-onboarding` with `field-0…field-N` (radio and checkbox values as JSON arrays of the chosen labels, e.g. `["Hold"]`) → JSON `{formWaitingUrl}` → poll `<formWaitingUrl path>/n8n-execution-status?signature=…` until `form-waiting` → GET the next page at `formWaitingUrl` → POST its fields to `formWaitingUrl` → repeat; after page 4 the GET returns the done page. HTML fields count in the `field-N` numbering (page 4: `field-0` is the summary, `field-1…5` the mix, `field-6` the cushion, `field-7` consent).
- **Check the rows:**
  ```bash
  DB=~/.n8n/database.sqlite; t(){ sqlite3 -readonly $DB "select id from data_table where name='$1'"; }
  for tb in users profiles budgets; do sqlite3 -readonly -header $DB "select * from data_table_user_$(t $tb) where user_id='test-d';"; done
  ```
- **What landed (2026-11-14):** `users` test-d active, buffer_target 200, defaults for the rest; `profiles` test-d growth (84 / 60, more_canada), `allocation_json` = the edited `{"equity_us":0.4,"equity_intl":0.2,"equity_ca":0.2,"bonds":0.2,"cash":0}`, warnings `["low_emergency_fund","high_interest_debt"]`, template explanation; `budgets` 7 rows. A retake with `TEST-D@leftover.test`, horizon `<3` and no consent updated the same rows (cash, paused, `created_at` unchanged, no duplicates), and its page 2 was prefilled from the saved budgets. Maya's rows were not touched.

## Snippets for `n8n/templates/node-snippets.json` (P0 owns it; all from this workflow)
| use | node in LO-01 | verified |
|---|---|---|
| Form Trigger v2.6, fields with `fieldName`, path option, no attribution | `Page 1: Financial profile` | executed |
| Form v2.5 page defined by JSON (`defineForm: "json"`, `jsonOutput: "={{ JSON.stringify($json.fields) }}"`) | `Page 2: Weekly budgets` | executed |
| Form v2.5 completion with HTML message from an expression | `Done` | executed |
| Data Table upsert (`matchType: allConditions`, filter values from `{{ $json.x }}`, `autoMapInputData`) | `Save budgets` | executed |
| Anthropic "Message a model", disabled, `onError: continueRegularOutput` | `Explain (LLM)` | published (disabled, never ran) |

Form gotchas worth keeping with the snippets:
- With `fieldName` set (Form Trigger ≥ 2.4, Form ≥ 2.5), a page returns `{fieldName: value}`; without it, the label is the key.
- In a JSON-defined page, n8n turns `<` and `>` into entities in every string except `html`, so option labels must not contain them (their submitted value would change).
- HTML fields are sanitized: no `style` attributes; `h1–h6, p, ul, ol, li, table, strong, em, a, code, br` survive.
- Number fields come back as numbers; a cleared number field comes back as `0`.
- Each Form node needs its own `webhookId`; the trigger switches to multi-page mode by itself when Form nodes follow it.
- Query parameters named like a field's `fieldName` prefill it.

## Known gaps / for Z
- **LLM:** see above (credential + enable one node).
- **`dashboard_url`** config is empty, so the done page shows a placeholder line instead of the link. Z sets it.
- **Bank connection** (end of F1) isn't part of the form. In the demo it's the dashboard's "Connect sandbox bank" button (LO-02).
- **Size:** the four Code nodes each embed `lib/scoring.mjs` verbatim (spec §19.6), so the JSON is ~150 KB. `lib/scoring.test.mjs` fails when a copy drifts; `LO_UPDATE_WF01=1 npm test` re-pastes the lib into the workflow file.
- `profiles.tier` stays the computed tier even when the user edits the mix; the dashboard should show the mix from `allocation_json`.
- No server-side validation errors are shown in the form: every question is required in the browser, and the Code nodes throw on a missing answer or an invalid email (the user then sees n8n's generic error).
- Workflow settings have no `errorWorkflow` yet (Z adds `leftoverWF09errh`).

## Spec / contract changes
None needed to ship. Optional, for Sergio:
- §11.3 could record the exact weights and points above (they live only in `lib/scoring.mjs` now).
- §11.4 could state the suggested cushion target for a low emergency fund ($200 here).
