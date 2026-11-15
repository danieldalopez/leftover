// Tests for lib/scoring.mjs (spec §11, §14, §19.5) and for LO-01's copy of it.
// Run: npm test   (or node --test lib/scoring.test.mjs)
// LO_UPDATE_WF01=1 npm test re-pastes lib/scoring.mjs into LO-01's Code nodes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  LO_TIERS, LO_TIER_INFO, LO_SLEEVES, LO_DEFAULT_BUDGETS, LO_NEW_USER_DEFAULTS, LO_QUESTIONS, LO_CAPACITY,
  LO_WILLINGNESS, LO_WARNINGS, LO_DISCLAIMER,
  answerValue, answersFromForm, capacityScore, willingnessScore, tierForScore, lowerTier, homeBias, warningsFor,
  allocationFor, allocationToPercents, normalizeAllocation, scoreProfile, mixPhrase, templateExplanation,
  explanationPrompt, extractLlmText, checkExplanation, normalizeEmail, isEmail, slugify, shortHash, resolveUserId,
  budgetDefaults, parseBudgets, parseBufferTarget, consentGiven, questionFields, budgetFields, resultFields, buildRows,
} from './scoring.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const seed = JSON.parse(readFileSync(join(root, 'demo/seed-data.json'), 'utf8'));

// A full answer set; override what a test cares about.
const BASE = {
  age_range: '25-34', income_type: 'salaried', monthly_take_home: '3000-4000', pay_frequency: 'biweekly',
  emergency_fund_months: '3-6', high_interest_debt: false, account_type: 'TFSA', goal: 'long_term_wealth',
  horizon: '10-20', drop_reaction: 'hold', max_drop: '20', experience: 'some', income_stability: 'very',
  geo_preference: 'global',
};
const A = (over) => ({ ...BASE, ...over });
const sum = (o) => LO_SLEEVES.reduce((a, s) => a + o[s], 0);
const close = (a, b) => Math.abs(a - b) < 1e-9;

// ---------- tiers ----------
test('tierForScore: every §11.3 boundary', () => {
  const cases = [[0, 'cash'], [19, 'cash'], [19.99, 'cash'], [20, 'conservative'], [39, 'conservative'],
    [40, 'balanced'], [59, 'balanced'], [60, 'growth'], [79, 'growth'], [80, 'all_equity'], [100, 'all_equity']];
  for (const [score, tier] of cases) assert.equal(tierForScore(score), tier, `score ${score}`);
  assert.throws(() => tierForScore('abc'));
  assert.throws(() => tierForScore(NaN));
});

test('lowerTier: the more cautious of two tiers, in either order', () => {
  assert.equal(lowerTier('growth', 'balanced'), 'balanced');
  assert.equal(lowerTier('balanced', 'growth'), 'balanced');
  assert.equal(lowerTier('all_equity', 'cash'), 'cash');
  assert.equal(lowerTier('conservative', 'conservative'), 'conservative');
  assert.throws(() => lowerTier('growth', 'yolo'));
});

// ---------- scores ----------
test('weights: capacity and willingness weights each sum to 1, horizon is the heaviest', () => {
  const w = (t) => Object.values(t).reduce((a, x) => a + x.weight, 0);
  assert.ok(close(w(LO_CAPACITY), 1));
  assert.ok(close(w(LO_WILLINGNESS), 1));
  const heaviest = Object.entries(LO_CAPACITY).sort((a, b) => b[1].weight - a[1].weight)[0][0];
  assert.equal(heaviest, 'horizon');
});

test('points: every option scores, strictly ordered along the form\'s option order, from 0 to 100', () => {
  for (const table of [LO_CAPACITY, LO_WILLINGNESS]) {
    for (const [key, { points }] of Object.entries(table)) {
      const values = LO_QUESTIONS.find((q) => q.key === key).options.map(([v]) => String(v));
      assert.equal(Object.keys(points).length, values.length, `${key}: points for exactly the form's options`);
      let pts = values.map((v) => points[v]);
      assert.ok(pts.every((p) => typeof p === 'number'), `${key}: an option has no points`);
      if (pts[0] > pts[pts.length - 1]) pts = pts.reverse(); // income stability lists "very stable" first
      assert.equal(pts[0], 0, `${key} lowest is 0`);
      assert.equal(pts[pts.length - 1], 100, `${key} highest is 100`);
      for (let i = 1; i < pts.length; i += 1) assert.ok(pts[i] > pts[i - 1], `${key} is strictly ordered`);
    }
  }
});

test('scores: extremes are 0 and 100', () => {
  const low = A({ horizon: '<3', income_stability: 'not', emergency_fund_months: '0', drop_reaction: 'sell_all', max_drop: '5', experience: 'none' });
  const high = A({ horizon: '20+', income_stability: 'very', emergency_fund_months: '6+', drop_reaction: 'buy_more', max_drop: '40+', experience: 'experienced' });
  assert.equal(capacityScore(low), 0);
  assert.equal(willingnessScore(low), 0);
  assert.equal(capacityScore(high), 100);
  assert.equal(willingnessScore(high), 100);
});

test('scores: a missing or unknown answer throws instead of guessing', () => {
  const { horizon, ...noHorizon } = BASE;
  assert.throws(() => capacityScore(noHorizon), /horizon/);
  assert.throws(() => willingnessScore(A({ max_drop: '25' })), /max_drop/);
});

test('seed: Maya\'s answers reproduce her seeded scores, tier and allocation', () => {
  const p = seed.profile;
  const r = scoreProfile(p.answers);
  assert.equal(r.capacity_score, p.capacity_score);
  assert.equal(r.willingness_score, p.willingness_score);
  assert.equal(r.tier, p.tier);
  assert.equal(r.home_bias, p.home_bias);
  assert.deepEqual(r.allocation, p.allocation);
  assert.deepEqual(r.warnings, p.warnings);
});

// ---------- final tier and the hard rule ----------
test('final tier = the lower of the two: capacity lower', () => {
  // capacity: .6*20 + .2*50 + .2*40 = 30 (conservative); willingness 100 (all_equity)
  const r = scoreProfile(A({ horizon: '3-5', income_stability: 'somewhat', emergency_fund_months: '1-3', drop_reaction: 'buy_more', max_drop: '40+', experience: 'experienced' }));
  assert.equal(r.capacity_score, 30);
  assert.equal(r.willingness_score, 100);
  assert.equal(r.tier, 'conservative');
  assert.equal(r.limited_by, 'capacity');
});

test('final tier = the lower of the two: willingness lower', () => {
  // capacity 100 (all_equity); willingness .4*30 + .4*20 + 0 = 20 (conservative)
  const r = scoreProfile(A({ horizon: '20+', emergency_fund_months: '6+', drop_reaction: 'sell_some', max_drop: '10', experience: 'none' }));
  assert.equal(r.capacity_score, 100);
  assert.equal(r.willingness_score, 20);
  assert.equal(r.tier, 'conservative');
  assert.equal(r.limited_by, 'willingness');
});

test('final tier: equal tiers', () => {
  // capacity .6*40 + 20 + .2*70 = 58 (balanced); willingness 48 (balanced)
  const r = scoreProfile(A({ horizon: '5-10' }));
  assert.equal(r.tier, 'balanced');
  assert.equal(r.limited_by, 'both');
});

test('hard rule: horizon under 3 years forces cash, even with everything else maxed', () => {
  const r = scoreProfile(A({ horizon: '<3', emergency_fund_months: '6+', drop_reaction: 'buy_more', max_drop: '40+', experience: 'experienced' }));
  assert.equal(r.capacity_score, 40); // balanced on its own
  assert.equal(r.willingness_score, 100);
  assert.equal(r.tier, 'cash');
  assert.equal(r.forced_cash, true);
  assert.equal(r.limited_by, 'horizon');
  assert.deepEqual(r.allocation, { equity_us: 0, equity_intl: 0, equity_ca: 0, bonds: 0, cash: 1 });
});

test('hard rule: 3 to 5 years does not force cash', () => {
  const r = scoreProfile(A({ horizon: '3-5', emergency_fund_months: '6+', drop_reaction: 'buy_more', max_drop: '40+', experience: 'experienced' }));
  assert.equal(r.forced_cash, false);
  assert.equal(r.tier, 'balanced'); // capacity .6*20+20+20 = 52
});

test('every tier is reachable from real answers', () => {
  const seen = new Set();
  const h = ['<3', '3-5', '5-10', '10-20', '20+'];
  const d = ['sell_all', 'sell_some', 'hold', 'buy_more'];
  const m = ['5', '10', '20', '30', '40+'];
  for (const horizon of h) for (const drop_reaction of d) for (const max_drop of m) {
    seen.add(scoreProfile(A({ horizon, drop_reaction, max_drop, emergency_fund_months: '6+', experience: 'experienced' })).tier);
  }
  assert.deepEqual([...seen].sort(), [...LO_TIERS].sort());
});

// ---------- warnings ----------
test('warnings (§11.4): emergency fund 0 or under 1 month, debt above 8%', () => {
  assert.deepEqual(warningsFor(A({ emergency_fund_months: '0' })), ['low_emergency_fund']);
  assert.deepEqual(warningsFor(A({ emergency_fund_months: '<1' })), ['low_emergency_fund']);
  assert.deepEqual(warningsFor(A({ emergency_fund_months: '1-3' })), []);
  assert.deepEqual(warningsFor(A({ high_interest_debt: true })), ['high_interest_debt']);
  assert.deepEqual(warningsFor(A({ emergency_fund_months: '0', high_interest_debt: true })), ['low_emergency_fund', 'high_interest_debt']);
});

test('warnings: spec text word for word, a bigger suggested cushion when the fund is low', () => {
  assert.equal(LO_WARNINGS.low_emergency_fund, 'Many people build a cash cushion first.');
  assert.equal(LO_WARNINGS.high_interest_debt, 'Paying off debt above 8% is a guaranteed return many people prioritize.');
  const low = scoreProfile(A({ emergency_fund_months: '0', high_interest_debt: true }));
  assert.deepEqual(low.warning_messages, [LO_WARNINGS.low_emergency_fund, LO_WARNINGS.high_interest_debt]);
  assert.equal(low.suggested_buffer_target, 200);
  assert.equal(scoreProfile(BASE).suggested_buffer_target, 100);
  // warnings never change the tier: the user may continue
  assert.equal(low.tier, scoreProfile(A({ emergency_fund_months: '0' })).tier);
});

// ---------- allocation ----------
test('allocation (§11.5): every tier x home bias sums to 1 and matches the table', () => {
  for (const tier of LO_TIERS) {
    for (const bias of ['global', 'more_canada']) {
      const a = allocationFor(tier, bias);
      assert.ok(close(sum(a), 1), `${tier}/${bias} sums to ${sum(a)}`);
      const t = LO_TIER_INFO[tier];
      assert.ok(close(a.equity_us + a.equity_intl + a.equity_ca, t.equity / 100));
      assert.equal(a.bonds, t.bonds / 100);
      assert.equal(a.cash, t.cash / 100);
    }
  }
  assert.deepEqual(allocationFor('all_equity', 'global'), { equity_us: 0.6, equity_intl: 0.35, equity_ca: 0.05, bonds: 0, cash: 0 });
  assert.deepEqual(allocationFor('all_equity', 'more_canada'), { equity_us: 0.45, equity_intl: 0.25, equity_ca: 0.3, bonds: 0, cash: 0 });
  assert.deepEqual(allocationFor('conservative', 'more_canada'), { equity_us: 0.09, equity_intl: 0.05, equity_ca: 0.06, bonds: 0.6, cash: 0.2 });
  assert.throws(() => allocationFor('growth', 'mars'));
});

test('home bias: only "more Canada" changes the split', () => {
  assert.equal(homeBias('more_canada'), 'more_canada');
  assert.equal(homeBias('global'), 'global');
  assert.equal(homeBias('no_preference'), 'global');
});

test('allocationToPercents: whole percents that add up to 100', () => {
  for (const tier of LO_TIERS) {
    for (const bias of ['global', 'more_canada']) {
      const p = allocationToPercents(allocationFor(tier, bias));
      assert.equal(sum(p), 100);
      assert.ok(LO_SLEEVES.every((s) => Number.isInteger(p[s])));
    }
  }
  assert.equal(sum(allocationToPercents({ equity_us: 0.3333, equity_intl: 0.3333, equity_ca: 0.3334, bonds: 0, cash: 0 })), 100);
});

test('normalizeAllocation: the user\'s edit is kept, scaled to 100% when needed', () => {
  const suggested = allocationFor('balanced', 'global');
  const same = normalizeAllocation({ equity_us: 36, equity_intl: 21, equity_ca: 3, bonds: 40, cash: 0 }, suggested);
  assert.deepEqual(same.allocation, suggested);
  assert.equal(same.edited, false);
  assert.equal(same.scaled, false);

  const edited = normalizeAllocation({ equity_us: 40, equity_intl: 20, equity_ca: 20, bonds: 20, cash: 0 }, suggested);
  assert.deepEqual(edited.allocation, { equity_us: 0.4, equity_intl: 0.2, equity_ca: 0.2, bonds: 0.2, cash: 0 });
  assert.equal(edited.edited, true);

  const half = normalizeAllocation({ equity_us: 25, equity_intl: 0, equity_ca: 0, bonds: 25, cash: 0 }, suggested);
  assert.deepEqual(half.allocation, { equity_us: 0.5, equity_intl: 0, equity_ca: 0, bonds: 0.5, cash: 0 });
  assert.equal(half.scaled, true);

  const thirds = normalizeAllocation({ equity_us: 1, equity_intl: 1, equity_ca: 1, bonds: 0, cash: 0 }, suggested);
  assert.equal(sum(thirds.allocation), 1);

  const junk = normalizeAllocation({ equity_us: -10, equity_intl: 'x', equity_ca: null, bonds: '', cash: 0 }, suggested);
  assert.deepEqual(junk.allocation, suggested);
  assert.equal(junk.edited, false);

  const negIgnored = normalizeAllocation({ equity_us: -50, equity_intl: 0, equity_ca: 0, bonds: 100, cash: 0 }, suggested);
  assert.deepEqual(negIgnored.allocation, { equity_us: 0, equity_intl: 0, equity_ca: 0, bonds: 1, cash: 0 });
});

// ---------- form answers ----------
test('questions: unique keys, unique labels per question, no < or > (n8n escapes them)', () => {
  const keys = LO_QUESTIONS.map((q) => q.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const q of LO_QUESTIONS) {
    const labels = q.options.map(([, l]) => l);
    assert.equal(new Set(labels).size, labels.length, q.key);
    for (const s of [q.label, ...labels]) assert.ok(!/[<>]/.test(s), `${q.key}: "${s}"`);
  }
  // answers_json uses the same keys as the seed's profile.answers
  assert.deepEqual([...keys].sort(), Object.keys(seed.profile.answers).sort());
});

test('answersFromForm: labels (as the form returns them) become stored values', () => {
  const form = {};
  for (const q of LO_QUESTIONS) form[q.key] = q.options[q.options.length - 1][1];
  form.high_interest_debt = 'Yes';
  form.income_type = ['Hourly']; // radio values can arrive as a one-item array
  const { answers, missing } = answersFromForm(form);
  assert.deepEqual(missing, []);
  assert.equal(answers.high_interest_debt, true);
  assert.equal(answers.income_type, 'hourly');
  assert.equal(answers.horizon, '20+');
  assert.equal(answers.emergency_fund_months, '6+');
  assert.equal(answerValue('high_interest_debt', 'No'), false);
  assert.equal(answerValue('horizon', '10-20'), '10-20'); // stored values pass through
  assert.equal(answerValue('horizon', 'next week'), undefined);
});

test('answersFromForm: per page, reports what is missing', () => {
  const r = answersFromForm({ goal: 'Retirement', horizon: 'In 3 to 5 years' }, 'quiz');
  assert.deepEqual(r.answers, { goal: 'retirement', horizon: '3-5' });
  assert.deepEqual(r.missing, ['drop_reaction', 'max_drop', 'experience', 'income_stability', 'geo_preference']);
  assert.equal(answersFromForm({}, 'profile').missing.length, 7);
});

// ---------- explanation ----------
const ALL_CASES = [
  A({}), A({ horizon: '<3' }), A({ horizon: '20+', emergency_fund_months: '6+' }),
  A({ horizon: '3-5', income_stability: 'not', emergency_fund_months: '0', drop_reaction: 'buy_more', max_drop: '40+', experience: 'experienced' }),
  A({ geo_preference: 'more_canada', horizon: '20+', drop_reaction: 'buy_more', max_drop: '40+', experience: 'experienced', emergency_fund_months: '6+' }),
  A({ drop_reaction: 'sell_all', max_drop: '5', experience: 'none' }),
];

test('template explanation: 3-4 sentences, general language, passes its own check', () => {
  for (const answers of ALL_CASES) {
    const r = scoreProfile(answers);
    const text = templateExplanation(r, answers);
    const sentences = text.split(/(?<=[.!?])\s+/).length;
    assert.ok(sentences >= 3 && sentences <= 4, `${sentences} sentences: ${text}`);
    assert.ok(text.includes(r.tier_label));
    assert.match(text, /not a recommendation to buy, sell or hold any specific security/);
    assert.match(text, /change it anytime/);
    assert.ok(!/\b(VTI|VXUS|EWC|BND|SGOV)\b/.test(text));
    assert.equal(checkExplanation(text), text);
  }
});

test('mixPhrase: plain description of a mix', () => {
  assert.equal(mixPhrase(allocationFor('balanced', 'global')), '60% stocks and 40% bonds');
  assert.equal(mixPhrase(allocationFor('conservative', 'global')), '20% stocks, 60% bonds and 20% cash-like holdings');
  assert.equal(mixPhrase(allocationFor('cash', 'global')), 'all cash-like holdings');
  assert.equal(mixPhrase(allocationFor('all_equity', 'more_canada')), 'all stocks');
});

test('explanationPrompt: carries the compliance rules and the result', () => {
  const r = scoreProfile(seed.profile.answers);
  const { system, user } = explanationPrompt(r, seed.profile.answers);
  assert.match(system, /3 to 4 sentences/);
  assert.match(system, /Never name, recommend or rank any specific security/);
  assert.match(system, /never tell the reader to buy, sell or hold/);
  assert.match(user, /Balanced mix/);
  assert.match(user, /64\/100/);
  assert.match(user, /48\/100/);
});

test('extractLlmText: Anthropic and OpenAI node shapes; nothing from a passed-through item', () => {
  const t = 'Your answers point to a balanced mix.';
  assert.equal(extractLlmText({ content: [{ type: 'text', text: t }] }), t);
  assert.equal(extractLlmText({ text: t }), t);
  assert.equal(extractLlmText({ message: { role: 'assistant', content: t } }), t);
  assert.equal(extractLlmText({ choices: [{ message: { content: t } }] }), t);
  assert.equal(extractLlmText({ output: [{ type: 'message', content: [{ type: 'output_text', text: t }] }] }), t);
  assert.equal(extractLlmText({ output: t }), t);
  // the disabled node passes Score answers' item through: no LLM text in it
  assert.equal(extractLlmText({ user_id: 'x', template_explanation: t, llm_prompt: 'p', llm_system: 's', result: {} }), null);
  assert.equal(extractLlmText(null), null);
  assert.equal(extractLlmText({ error: 'Credentials not found' }), null);
});

test('checkExplanation: rejects tickers, advice, wrong length; cleans quotes', () => {
  const good = 'Your answers point to a balanced mix of stocks and bonds. Your long horizon leaves room for growth, while your comfort with drops keeps some bonds in the mix. This is a general mix based on your own answers, and you can change it anytime.';
  assert.equal(checkExplanation(good), good);
  assert.equal(checkExplanation(`"${good}"`), good);
  assert.equal(checkExplanation(`${good} A fund like VTI fits.`), null);
  assert.equal(checkExplanation(`${good} You should buy more bonds now.`), null);
  assert.equal(checkExplanation(`${good} Returns are guaranteed.`), null);
  assert.equal(checkExplanation('Too short.'), null);
  assert.equal(checkExplanation(good.repeat(5)), null);
  assert.equal(checkExplanation(undefined), null);
  assert.equal(checkExplanation(`${good} XYZ is fine.`, ['XYZ']), null);
});

// ---------- users ----------
test('email: normalized, validated', () => {
  assert.equal(normalizeEmail('  Test-D@Leftover.TEST '), 'test-d@leftover.test');
  assert.ok(isEmail('a@b.co'));
  assert.ok(!isEmail('nope'));
  assert.ok(!isEmail('a@b'));
  assert.equal(slugify('Sergio.Lopez+demo'), 'sergio-lopez-demo');
  assert.equal(slugify('***'), '');
  assert.equal(shortHash('x@y.z'), shortHash('x@y.z'));
  assert.match(shortHash('x@y.z'), /^[0-9a-f]{6}$/);
});

test('resolveUserId: new user gets the slug of the email\'s local part', () => {
  assert.deepEqual(resolveUserId('test-d@leftover.test', []), { user_id: 'test-d', is_new: true });
  assert.deepEqual(resolveUserId('Jo.Smith@x.com', [{ user_id: 'maya', email: 'maya@example.com' }]), { user_id: 'jo-smith', is_new: true });
  assert.equal(resolveUserId('!!!@x.com', []).user_id, 'user');
});

test('resolveUserId: the same email (any case) finds the existing user', () => {
  const users = [{ user_id: 'test-d', email: 'test-d@leftover.test' }];
  assert.deepEqual(resolveUserId('TEST-D@leftover.test', users), { user_id: 'test-d', is_new: false });
});

test('resolveUserId: a taken id gets a stable hash suffix; maya is never matched or reused', () => {
  const users = [{ user_id: 'test-d', email: 'someone-else@x.com' }, { user_id: 'maya', email: 'maya@example.com' }];
  const r = resolveUserId('test-d@other.com', users);
  assert.equal(r.is_new, true);
  assert.match(r.user_id, /^test-d-[0-9a-f]{6}$/);
  assert.equal(resolveUserId('test-d@other.com', users).user_id, r.user_id);
  const m = resolveUserId('maya@example.com', users);
  assert.equal(m.is_new, true);
  assert.match(m.user_id, /^maya-[0-9a-f]{6}$/);
  // and once that user exists, retaking finds it, not maya
  assert.deepEqual(resolveUserId('maya@example.com', [...users, { user_id: m.user_id, email: 'maya@example.com' }]), { user_id: m.user_id, is_new: false });
  assert.throws(() => resolveUserId('bad', users), /invalid email/);
});

// ---------- budgets, cushion, consent ----------
test('budgets: §6.2 defaults, or the user\'s current ones', () => {
  const d = budgetDefaults([]);
  assert.deepEqual(d.map((b) => [b.category_key, b.weekly_amount]), LO_DEFAULT_BUDGETS.map((b) => [b.category_key, b.weekly_amount]));
  assert.deepEqual(d.map((b) => b.weekly_amount), [80, 50, 30, 40, 40, 20, 20]);
  const mine = budgetDefaults([{ category_key: 'groceries', weekly_amount: 95, active: 1 }, { category_key: 'shopping', weekly_amount: 0, active: 0 }]);
  assert.equal(mine[0].weekly_amount, 95);
  assert.equal(mine[4].weekly_amount, 0);
  assert.equal(mine[4].active, false);
  assert.equal(mine[1].weekly_amount, 50);
});

test('parseBudgets: edits kept, cents, invalid or negative -> prefill, capped', () => {
  const rows = parseBudgets({ budget_groceries: 92.456, budget_eating_out: -5, budget_transport: '', budget_entertainment: 'x', budget_shopping: 0, budget_personal_care: 99999 }, 'test-d');
  const by = Object.fromEntries(rows.map((r) => [r.category_key, r]));
  assert.equal(rows.length, 7);
  assert.equal(by.groceries.weekly_amount, 92.46);
  assert.equal(by.eating_out.weekly_amount, 50);
  assert.equal(by.transport.weekly_amount, 30);
  assert.equal(by.entertainment.weekly_amount, 40);
  assert.equal(by.shopping.weekly_amount, 0);
  assert.equal(by.personal_care.weekly_amount, 10000);
  assert.equal(by.other.weekly_amount, 20);
  assert.ok(rows.every((r) => r.user_id === 'test-d' && r.active === true && r.label));
});

test('cushion target and consent parsing', () => {
  assert.equal(parseBufferTarget(150, 100), 150);
  assert.equal(parseBufferTarget('', 200), 200);
  assert.equal(parseBufferTarget(-1, 100), 100);
  assert.equal(parseBufferTarget(1e9, 100), 5000);
  assert.equal(consentGiven(['Invest my weekly leftover automatically']), true);
  assert.equal(consentGiven([]), false);
  assert.equal(consentGiven(null), false);
  assert.equal(consentGiven('true'), true);
});

// ---------- n8n form pages ----------
const N8N_FIELD_KEYS = ['fieldLabel', 'fieldType', 'placeholder', 'defaultValue', 'fieldOptions', 'multiselect', 'multipleFiles',
  'acceptFileTypes', 'formatDate', 'requiredField', 'fieldValue', 'elementName', 'html', 'fieldName', 'limitSelection',
  'numberOfSelections', 'minSelections', 'maxSelections'];
const checkFields = (fields) => {
  for (const f of fields) for (const k of Object.keys(f)) assert.ok(N8N_FIELD_KEYS.includes(k), `key ${k} not allowed in a JSON form page`);
};

test('form pages: only keys n8n accepts; question fields return the answer keys', () => {
  const quiz = questionFields('quiz');
  checkFields(quiz);
  assert.deepEqual(quiz.map((f) => f.fieldName), ['goal', 'horizon', 'drop_reaction', 'max_drop', 'experience', 'income_stability', 'geo_preference']);
  assert.ok(quiz.every((f) => f.requiredField && f.fieldOptions.values.length >= 3));
  const budgets = budgetFields(budgetDefaults([]));
  checkFields(budgets);
  assert.deepEqual(budgets.map((f) => f.defaultValue), [80, 50, 30, 40, 40, 20, 20]);
  assert.ok(budgets.every((f) => f.fieldName.startsWith('budget_') && f.fieldType === 'number'));
});

test('result page: explanation, prefilled mix adding to 100, optional consent, disclaimer', () => {
  const answers = A({ emergency_fund_months: '0' });
  const r = scoreProfile(answers);
  const fields = resultFields(r, templateExplanation(r, answers), true);
  checkFields(fields);
  const alloc = fields.filter((f) => f.fieldName && f.fieldName.startsWith('alloc_'));
  assert.deepEqual(alloc.map((f) => f.fieldName), LO_SLEEVES.map((s) => `alloc_${s}`));
  assert.equal(alloc.reduce((a, f) => a + f.defaultValue, 0), 100);
  assert.equal(fields.find((f) => f.fieldName === 'buffer_target').defaultValue, 200);
  const consent = fields.find((f) => f.fieldName === 'consent');
  assert.equal(consent.fieldType, 'checkbox');
  assert.equal(consent.requiredField, false);
  assert.match(consent.fieldOptions.values[0].option, /I can pause anytime/);
  const html = fields.filter((f) => f.fieldType === 'html').map((f) => f.html).join('');
  assert.match(html, /Many people build a cash cushion first/);
  assert.match(html, /not a recommendation to buy, sell or hold any specific security/);
  assert.ok(html.includes(LO_DISCLAIMER));
  assert.ok(!/style=/.test(html)); // n8n strips style attributes
});

// ---------- rows vs contracts/data-tables.md ----------
function contractColumns(table) {
  const md = readFileSync(join(root, 'contracts/data-tables.md'), 'utf8');
  const start = md.indexOf(`## ${table}.`);
  const section = md.slice(start, md.indexOf('\n## ', start + 1));
  return [...section.matchAll(/^\| (\w+) \| (string|number|boolean|date|\*\*string\*\*) \|/gm)].map((m) => m[1]);
}

function rowsFor(isNew, consent) {
  const answers = A({ emergency_fund_months: '<1' });
  const result = scoreProfile(answers);
  return buildRows({
    userId: 'test-d', isNew, name: ' Dana ', email: 'Test-D@Leftover.test', consent, bufferTarget: 200, answers, result,
    allocation: normalizeAllocation({ equity_us: 40, equity_intl: 20, equity_ca: 0, bonds: 40, cash: 0 }, result.allocation).allocation,
    explanation: templateExplanation(result, answers), budgets: parseBudgets({}, 'test-d'), now: new Date('2026-11-14T20:00:00Z'),
  });
}

test('buildRows: a new user gets every users column with the defaults', () => {
  const { user } = rowsFor(true, true);
  assert.deepEqual(Object.keys(user).sort(), contractColumns('users').sort());
  assert.equal(user.email, 'test-d@leftover.test');
  assert.equal(user.name, 'Dana');
  assert.equal(user.status, 'active');
  assert.equal(user.consent_at, '2026-11-14T20:00:00.000Z');
  assert.equal(user.created_at, '2026-11-14T20:00:00.000Z');
  assert.equal(user.buffer_target, 200);
  for (const k of ['buffer_balance', 'cushion_rate', 'absorb_overspend', 'min_invest', 'max_weekly_invest', 'pending_carry', 'deficit_carry']) {
    assert.equal(user[k], LO_NEW_USER_DEFAULTS[k], k);
  }
});

test('buildRows: a returning user keeps buffer, carries and created_at; no consent pauses', () => {
  const { user } = rowsFor(false, false);
  assert.deepEqual(Object.keys(user).sort(), ['buffer_target', 'email', 'name', 'status', 'user_id']);
  assert.equal(user.status, 'paused');
  assert.ok(!('consent_at' in user));
  assert.ok(!('buffer_balance' in user));
  assert.ok(!('created_at' in user));
});

test('buildRows: profile row has exactly the contract columns and the edited allocation', () => {
  const { profile, budgets } = rowsFor(true, true);
  assert.deepEqual(Object.keys(profile).sort(), contractColumns('profiles').sort());
  assert.deepEqual(JSON.parse(profile.allocation_json), { equity_us: 0.4, equity_intl: 0.2, equity_ca: 0, bonds: 0.4, cash: 0 });
  assert.deepEqual(JSON.parse(profile.warnings_json), ['low_emergency_fund']);
  assert.equal(JSON.parse(profile.answers_json).emergency_fund_months, '<1');
  assert.ok(LO_TIERS.includes(profile.tier));
  assert.equal(budgets.length, 7);
  for (const b of budgets) assert.deepEqual(Object.keys(b).sort(), contractColumns('budgets').sort());
});

// ---------- LO-01 embeds this file verbatim ----------
const LIB_BEGIN = '// ===== lib/scoring.mjs (pasted verbatim: edit the lib, then LO_UPDATE_WF01=1 npm test) =====';
const LIB_END = '// ===== end lib/scoring.mjs =====';
const WF = join(root, 'n8n/workflows/01-onboarding-form.json');

test('LO-01: every Code node that uses the lib carries the current lib/scoring.mjs', () => {
  const libBody = readFileSync(join(root, 'lib/scoring.mjs'), 'utf8').replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').trim();
  const wf = JSON.parse(readFileSync(WF, 'utf8'));
  const withLib = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code' && n.parameters.jsCode.includes(LIB_BEGIN));
  assert.ok(withLib.length >= 4, 'expected the lib in Identify user, Score answers, Pick explanation, Build rows');
  let changed = false;
  for (const n of withLib) {
    const js = n.parameters.jsCode;
    const a = js.indexOf(LIB_BEGIN) + LIB_BEGIN.length;
    const b = js.indexOf(LIB_END);
    const embedded = js.slice(a, b).trim();
    if (embedded === libBody) continue;
    if (process.env.LO_UPDATE_WF01) {
      n.parameters.jsCode = `${js.slice(0, a)}\n${libBody}\n${js.slice(b)}`;
      changed = true;
    } else {
      assert.fail(`${n.name}: embedded lib/scoring.mjs is out of date. Run LO_UPDATE_WF01=1 npm test, then push.`);
    }
  }
  if (changed) writeFileSync(WF, `${JSON.stringify(wf, null, 2)}\n`);
});

test('LO-01: page 1 asks the §11.1 questions exactly as the lib parses them', () => {
  const wf = JSON.parse(readFileSync(WF, 'utf8'));
  const trigger = wf.nodes.find((n) => n.type === 'n8n-nodes-base.formTrigger');
  const fields = trigger.parameters.formFields.values;
  assert.deepEqual(fields.slice(0, 2).map((f) => f.fieldName), ['name', 'email']);
  assert.deepEqual(fields.slice(2), questionFields('profile'));
  assert.equal(wf.id, 'leftoverWF01form');
  assert.equal(wf.active, true);
});
