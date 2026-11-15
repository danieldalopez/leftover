// lib/scoring.mjs: onboarding logic for LO-01 (spec §7 F1, §10 WF01, §11, §14).
//
//   quiz answers -> capacity + willingness scores (0-100) -> a tier for each
//   -> final tier = the lower one (horizon under 3 years forces cash)
//   -> allocation (§11.5 + home bias), warnings (§11.4), explanation.
//
// It also holds the small pieces LO-01 needs around the quiz: the questions and
// their form labels, default budgets, email -> user_id, the editable allocation,
// the explanation prompt + template fallback (§19.5), and the rows LO-01 writes.
//
// Plain functions, no imports, so this pastes straight into an n8n Code node:
// LO-01's Code nodes embed everything above the `export` line verbatim, and
// lib/scoring.test.mjs fails if they drift (LO_UPDATE_WF01=1 re-pastes them).

const LO_TIERS = ['cash', 'conservative', 'balanced', 'growth', 'all_equity'];

// §11.5: percent of the portfolio per asset class, by tier.
const LO_TIER_INFO = {
  cash: { label: 'Cash', equity: 0, bonds: 0, cash: 100 },
  conservative: { label: 'Conservative', equity: 20, bonds: 60, cash: 20 },
  balanced: { label: 'Balanced', equity: 60, bonds: 40, cash: 0 },
  growth: { label: 'Growth', equity: 80, bonds: 20, cash: 0 },
  all_equity: { label: 'All equity', equity: 100, bonds: 0, cash: 0 },
};

// §11.5: how the equity part splits, by home bias (percent of the equity part).
const LO_EQUITY_SPLIT = {
  global: { equity_us: 60, equity_intl: 35, equity_ca: 5 },
  more_canada: { equity_us: 45, equity_intl: 25, equity_ca: 30 },
};

const LO_SLEEVES = ['equity_us', 'equity_intl', 'equity_ca', 'bonds', 'cash'];
const LO_SLEEVE_LABELS = {
  equity_us: 'US stocks',
  equity_intl: 'International stocks',
  equity_ca: 'Canadian stocks',
  bonds: 'Bonds',
  cash: 'Cash (short-term T-bills)',
};

// §6.2 default weekly budgets (CAD).
const LO_DEFAULT_BUDGETS = [
  { category_key: 'groceries', label: 'Groceries', weekly_amount: 80 },
  { category_key: 'eating_out', label: 'Eating out and coffee', weekly_amount: 50 },
  { category_key: 'transport', label: 'Transport', weekly_amount: 30 },
  { category_key: 'entertainment', label: 'Fun and entertainment', weekly_amount: 40 },
  { category_key: 'shopping', label: 'Shopping', weekly_amount: 40 },
  { category_key: 'personal_care', label: 'Personal care', weekly_amount: 20 },
  { category_key: 'other', label: 'Other variable', weekly_amount: 20 },
];
const LO_MAX_WEEKLY_BUDGET = 10000;

// Defaults for a new users row (contracts/data-tables.md, spec §18 D2/D5).
const LO_NEW_USER_DEFAULTS = {
  timezone: 'America/Vancouver',
  buffer_balance: 0,
  buffer_target: 100,
  cushion_rate: 0.5,
  absorb_overspend: true,
  min_invest: 5,
  max_weekly_invest: 200,
  pending_carry: 0,
  deficit_carry: 0,
};
// §11.4: with little or no emergency fund, the result page suggests a bigger cushion.
const LO_LOW_EF_BUFFER_TARGET = 200;
const LO_MAX_BUFFER_TARGET = 5000;

// The demo user is never touched by the form (BUILD-PLAN ground rule 5).
const LO_PROTECTED_USER_IDS = ['maya'];

// §11.1 + §11.2. `value` is what answers_json stores (same keys and values as
// the seed's profile.answers); `label` is what the form shows and sends back.
// Labels avoid < and > because n8n escapes them in JSON-defined form pages.
const LO_QUESTIONS = [
  // Page 1: financial profile (§11.1)
  { key: 'age_range', page: 'profile', type: 'dropdown', label: 'Age range', options: [
    ['18-24', '18 to 24'], ['25-34', '25 to 34'], ['35-44', '35 to 44'],
    ['45-54', '45 to 54'], ['55-64', '55 to 64'], ['65+', '65 or older']] },
  { key: 'income_type', page: 'profile', type: 'radio', label: 'Income type', options: [
    ['salaried', 'Salaried'], ['hourly', 'Hourly'], ['freelance', 'Freelance or variable'], ['student', 'Student']] },
  { key: 'monthly_take_home', page: 'profile', type: 'dropdown', label: 'Monthly take-home pay (CAD)', options: [
    ['under-2000', 'Under $2,000'], ['2000-3000', '$2,000 to $3,000'], ['3000-4000', '$3,000 to $4,000'],
    ['4000-6000', '$4,000 to $6,000'], ['6000+', '$6,000 or more']] },
  { key: 'pay_frequency', page: 'profile', type: 'dropdown', label: 'How often are you paid?', options: [
    ['weekly', 'Weekly'], ['biweekly', 'Every two weeks'], ['semimonthly', 'Twice a month'],
    ['monthly', 'Monthly'], ['irregular', 'Irregularly']] },
  { key: 'emergency_fund_months', page: 'profile', type: 'radio', label: 'Emergency fund: how many months of expenses do you have saved?', options: [
    ['0', 'None yet'], ['<1', 'Less than 1 month'], ['1-3', '1 to 3 months'], ['3-6', '3 to 6 months'], ['6+', '6 months or more']] },
  { key: 'high_interest_debt', page: 'profile', type: 'radio', label: 'Any debt with interest above 8% (a credit card balance, for example)?', options: [
    [true, 'Yes'], [false, 'No']] },
  { key: 'account_type', page: 'profile', type: 'radio', label: 'Account you would hold this in (for your reference only)', options: [
    ['TFSA', 'TFSA'], ['RRSP', 'RRSP'], ['FHSA', 'FHSA'], ['non_registered', 'Non-registered'], ['not_sure', 'Not sure yet']] },
  // Page 3: investor quiz (§11.2; Q15 ESG is P2 and not asked)
  { key: 'goal', page: 'quiz', type: 'radio', label: 'Main goal', options: [
    ['retirement', 'Retirement'], ['house', 'A home'], ['long_term_wealth', 'Long-term wealth'], ['no_specific_goal', 'No specific goal']] },
  { key: 'horizon', page: 'quiz', type: 'radio', label: 'When might you need this money?', options: [
    ['<3', 'In less than 3 years'], ['3-5', 'In 3 to 5 years'], ['5-10', 'In 5 to 10 years'],
    ['10-20', 'In 10 to 20 years'], ['20+', 'In 20 years or more']] },
  { key: 'drop_reaction', page: 'quiz', type: 'radio', label: 'Your portfolio drops 30% in a year. You:', options: [
    ['sell_all', 'Sell everything'], ['sell_some', 'Sell some'], ['hold', 'Hold'], ['buy_more', 'Buy more']] },
  { key: 'max_drop', page: 'quiz', type: 'radio', label: 'Largest one-year drop you could live with', options: [
    ['5', '5%'], ['10', '10%'], ['20', '20%'], ['30', '30%'], ['40+', '40% or more']] },
  { key: 'experience', page: 'quiz', type: 'radio', label: 'Investing experience', options: [
    ['none', 'None'], ['some', 'Some'], ['experienced', 'Experienced']] },
  { key: 'income_stability', page: 'quiz', type: 'radio', label: 'How stable is your income?', options: [
    ['very', 'Very stable'], ['somewhat', 'Somewhat stable'], ['not', 'Not stable']] },
  { key: 'geo_preference', page: 'quiz', type: 'radio', label: 'For the stock part: geographic preference', options: [
    ['global', 'Global market weight'], ['more_canada', 'More Canada'], ['no_preference', 'No preference']] },
];

// §11.3 scoring. Each answer maps to 0-100 points; a score is the weighted sum.
// Capacity: horizon heaviest, then income stability and emergency fund.
// Willingness: reaction to a drop, the largest drop you could live with, experience.
const LO_CAPACITY = {
  horizon: { weight: 0.6, points: { '<3': 0, '3-5': 20, '5-10': 40, '10-20': 60, '20+': 100 } },
  income_stability: { weight: 0.2, points: { not: 0, somewhat: 50, very: 100 } },
  emergency_fund_months: { weight: 0.2, points: { 0: 0, '<1': 20, '1-3': 40, '3-6': 70, '6+': 100 } },
};
const LO_WILLINGNESS = {
  drop_reaction: { weight: 0.4, points: { sell_all: 0, sell_some: 30, hold: 60, buy_more: 100 } },
  max_drop: { weight: 0.4, points: { 5: 0, 10: 20, 20: 40, 30: 70, '40+': 100 } },
  experience: { weight: 0.2, points: { none: 0, some: 40, experienced: 100 } },
};

// §11.4 warning codes (warnings_json) and their text, word for word from the spec.
const LO_WARNINGS = {
  low_emergency_fund: 'Many people build a cash cushion first.',
  high_interest_debt: 'Paying off debt above 8% is a guaranteed return many people prioritize.',
};

// §14 wording shown with every result.
const LO_DISCLAIMER = 'Educational prototype using simulated (paper) trading. Not investment advice. Projections are illustrative.';
const LO_RESULT_NOTE = 'This is a general asset mix based on your own answers, not a recommendation to buy, sell or hold any specific security. You can change it below, and anytime later.';

function loRound2(x) {
  return Math.round((Number(x) + Number.EPSILON) * 100) / 100;
}

function loQuestion(key) {
  const q = LO_QUESTIONS.find((x) => x.key === key);
  if (!q) throw new Error(`unknown question ${key}`);
  return q;
}

// Form value (label, or already a stored value) -> stored value. Unknown -> undefined.
function answerValue(key, raw) {
  const q = loQuestion(key);
  if (Array.isArray(raw)) raw = raw[0];
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  const hit = q.options.find(([value, label]) => label === s || String(value) === s);
  return hit ? hit[0] : undefined;
}

function answerLabel(key, value) {
  const hit = loQuestion(key).options.find(([v]) => String(v) === String(value));
  return hit ? hit[1] : String(value);
}

// Every answer the form returned, as stored values. `missing` lists the keys
// with no valid answer (the form marks them all required, so this should be empty).
function answersFromForm(formJson, page) {
  const answers = {};
  const missing = [];
  for (const q of LO_QUESTIONS) {
    if (page && q.page !== page) continue;
    const v = answerValue(q.key, formJson ? formJson[q.key] : undefined);
    if (v === undefined) missing.push(q.key);
    else answers[q.key] = v;
  }
  return { answers, missing };
}

function loWeightedScore(table, answers) {
  let total = 0;
  for (const [key, { weight, points }] of Object.entries(table)) {
    const p = points[String(answers[key])];
    if (p === undefined) throw new Error(`score: missing or invalid answer for ${key}: ${answers[key]}`);
    total += weight * p;
  }
  return Math.max(0, Math.min(100, Math.round(total)));
}

function capacityScore(answers) {
  return loWeightedScore(LO_CAPACITY, answers);
}

function willingnessScore(answers) {
  return loWeightedScore(LO_WILLINGNESS, answers);
}

// §11.3: 0-19 cash, 20-39 conservative, 40-59 balanced, 60-79 growth, 80+ all_equity.
function tierForScore(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) throw new Error(`tierForScore: not a number ${score}`);
  if (s < 20) return 'cash';
  if (s < 40) return 'conservative';
  if (s < 60) return 'balanced';
  if (s < 80) return 'growth';
  return 'all_equity';
}

function lowerTier(a, b) {
  const ia = LO_TIERS.indexOf(a);
  const ib = LO_TIERS.indexOf(b);
  if (ia < 0 || ib < 0) throw new Error(`lowerTier: unknown tier ${ia < 0 ? a : b}`);
  return LO_TIERS[Math.min(ia, ib)];
}

function homeBias(geoPreference) {
  return geoPreference === 'more_canada' ? 'more_canada' : 'global';
}

// §11.4 warning codes, in a fixed order.
function warningsFor(answers) {
  const out = [];
  if (answers.emergency_fund_months === '0' || answers.emergency_fund_months === '<1') out.push('low_emergency_fund');
  if (answers.high_interest_debt === true || answers.high_interest_debt === 'true') out.push('high_interest_debt');
  return out;
}

// §11.5: sleeve weights (fractions summing to exactly 1) for a tier and home bias.
function allocationFor(tier, bias) {
  const t = LO_TIER_INFO[tier];
  const split = LO_EQUITY_SPLIT[bias];
  if (!t) throw new Error(`allocationFor: unknown tier ${tier}`);
  if (!split) throw new Error(`allocationFor: unknown home bias ${bias}`);
  // Percent * percent / 100 is a whole percent for every tier and split in §11.5.
  return {
    equity_us: (t.equity * split.equity_us) / 10000,
    equity_intl: (t.equity * split.equity_intl) / 10000,
    equity_ca: (t.equity * split.equity_ca) / 10000,
    bonds: t.bonds / 100,
    cash: t.cash / 100,
  };
}

// Fractions -> whole percents (for the form), summing to 100.
function allocationToPercents(allocation) {
  const pct = {};
  for (const s of LO_SLEEVES) pct[s] = Math.round((Number(allocation[s]) || 0) * 100);
  const drift = 100 - LO_SLEEVES.reduce((a, s) => a + pct[s], 0);
  if (drift !== 0) {
    const biggest = LO_SLEEVES.reduce((a, s) => (pct[s] > pct[a] ? s : a), LO_SLEEVES[0]);
    pct[biggest] += drift;
  }
  return pct;
}

// The user's edited percents -> fractions summing to exactly 1 (4 decimals).
// Blank or negative entries count as 0. If the total isn't 100 the entries are
// scaled to it; if everything is 0 or invalid, `fallback` (the suggested mix) is kept.
// Returns { allocation, edited, scaled }.
function normalizeAllocation(percents, fallback) {
  const raw = {};
  let total = 0;
  for (const s of LO_SLEEVES) {
    const n = Number(percents ? percents[s] : undefined);
    raw[s] = Number.isFinite(n) && n > 0 ? n : 0;
    total += raw[s];
  }
  if (!(total > 0)) return { allocation: { ...fallback }, edited: false, scaled: false };
  const allocation = {};
  for (const s of LO_SLEEVES) allocation[s] = Math.round((raw[s] / total) * 10000) / 10000;
  const drift = Math.round((1 - LO_SLEEVES.reduce((a, s) => a + allocation[s], 0)) * 10000) / 10000;
  if (drift !== 0) {
    const biggest = LO_SLEEVES.reduce((a, s) => (allocation[s] > allocation[a] ? s : a), LO_SLEEVES[0]);
    allocation[biggest] = Math.round((allocation[biggest] + drift) * 10000) / 10000;
  }
  const edited = LO_SLEEVES.some((s) => Math.abs(allocation[s] - (Number(fallback[s]) || 0)) > 0.00005);
  return { allocation, edited, scaled: Math.abs(total - 100) > 1e-9 };
}

// Everything §11.3-§11.5 derive from the answers.
function scoreProfile(answers) {
  const capacity = capacityScore(answers);
  const willingness = willingnessScore(answers);
  const capacityTier = tierForScore(capacity);
  const willingnessTier = tierForScore(willingness);
  const forcedCash = answers.horizon === '<3';
  const tier = forcedCash ? 'cash' : lowerTier(capacityTier, willingnessTier);
  const bias = homeBias(answers.geo_preference);
  const warnings = warningsFor(answers);
  let limitedBy = 'both';
  if (forcedCash) limitedBy = 'horizon';
  else if (LO_TIERS.indexOf(capacityTier) < LO_TIERS.indexOf(willingnessTier)) limitedBy = 'capacity';
  else if (LO_TIERS.indexOf(willingnessTier) < LO_TIERS.indexOf(capacityTier)) limitedBy = 'willingness';
  return {
    capacity_score: capacity,
    willingness_score: willingness,
    capacity_tier: capacityTier,
    willingness_tier: willingnessTier,
    tier,
    tier_label: LO_TIER_INFO[tier].label,
    forced_cash: forcedCash,
    limited_by: limitedBy,
    home_bias: bias,
    allocation: allocationFor(tier, bias),
    warnings,
    warning_messages: warnings.map((code) => LO_WARNINGS[code]),
    suggested_buffer_target: warnings.includes('low_emergency_fund') ? LO_LOW_EF_BUFFER_TARGET : LO_NEW_USER_DEFAULTS.buffer_target,
  };
}

// "about 60% stocks and 40% bonds", from an allocation (fractions).
function mixPhrase(allocation) {
  const pct = allocationToPercents(allocation);
  const stocks = pct.equity_us + pct.equity_intl + pct.equity_ca;
  const parts = [];
  if (stocks) parts.push(`${stocks}% stocks`);
  if (pct.bonds) parts.push(`${pct.bonds}% bonds`);
  if (pct.cash) parts.push(`${pct.cash}% cash-like holdings`);
  if (parts.length === 1) return stocks === 100 ? 'all stocks' : pct.cash === 100 ? 'all cash-like holdings' : parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function loHorizonPhrase(h) {
  return { '<3': 'less than 3 years', '3-5': '3 to 5 years', '5-10': '5 to 10 years', '10-20': '10 to 20 years', '20+': '20 years or more' }[h] || 'an unknown time';
}

function loStabilityPhrase(v) {
  return { very: 'very stable income', somewhat: 'somewhat stable income', not: 'income that is not stable' }[v] || 'your income';
}

function loFundPhrase(v) {
  return {
    0: 'no emergency savings yet', '<1': 'less than a month of emergency savings', '1-3': '1 to 3 months of emergency savings',
    '3-6': '3 to 6 months of emergency savings', '6+': '6 or more months of emergency savings',
  }[v] || 'your emergency savings';
}

// §19.5 fallback: the explanation used whenever the LLM is missing, fails, or
// returns something that breaks the rules in checkExplanation(). 3-4 sentences,
// general language, never names a security.
function templateExplanation(result, answers) {
  const s = [];
  s.push(`Your answers point to the ${result.tier_label} mix: ${mixPhrase(result.allocation)}.`);
  if (result.limited_by === 'horizon') {
    s.push('You said you may need this money within 3 years, and money needed that soon is usually kept in cash-like holdings rather than exposed to market swings.');
  } else {
    if (result.tier !== 'cash') {
      s.push(result.home_bias === 'more_canada'
        ? 'The stock part leans more toward Canada, as you asked.'
        : 'The stock part follows global market weights.');
    }
    const drop = answers.max_drop === '40+' ? '40% or more' : `${answers.max_drop}%`;
    const horizon = `a horizon of ${loHorizonPhrase(answers.horizon)}`;
    if (result.limited_by === 'willingness') {
      s.push(`Your situation (${horizon} and ${loStabilityPhrase(answers.income_stability)}) leaves room for more growth, but you said a ${drop} drop in a year is about the most you would want to sit through, so the mix follows your comfort level.`);
    } else if (result.limited_by === 'capacity') {
      s.push(`You are comfortable with bigger swings, but your situation (${horizon}, ${loStabilityPhrase(answers.income_stability)} and ${loFundPhrase(answers.emergency_fund_months)}) leaves less room for risk, so the mix follows that.`);
    } else {
      s.push(`Your situation (${horizon}) and your comfort with market swings point to the same level of risk.`);
    }
  }
  s.push('This is a general asset mix based on your own answers, not a recommendation to buy, sell or hold any specific security, and you can change it anytime.');
  return s.join(' ');
}

// What the LLM node gets (spec §10 WF01): 3-4 sentences, plain language, general.
function explanationPrompt(result, answers) {
  const pct = allocationToPercents(result.allocation);
  const system = [
    'You write short, plain-language explanations for an educational budgeting prototype that uses simulated (paper) trading.',
    'Rules: 3 to 4 sentences, under 90 words, no headings, no lists, no greeting.',
    'Talk only about the general asset mix (stocks, bonds, cash) and why the answers lead to it.',
    'Never name, recommend or rank any specific security, fund or ticker, and never tell the reader to buy, sell or hold anything.',
    'End by saying it is a general mix based on their own answers and that they can change it anytime.',
  ].join(' ');
  const user = [
    `Result: ${result.tier_label} mix (${mixPhrase(result.allocation)}; US ${pct.equity_us}%, international ${pct.equity_intl}%, Canada ${pct.equity_ca}%, bonds ${pct.bonds}%, cash ${pct.cash}%).`,
    `Capacity for risk: ${result.capacity_score}/100 (time horizon ${loHorizonPhrase(answers.horizon)}, ${loStabilityPhrase(answers.income_stability)}, ${loFundPhrase(answers.emergency_fund_months)}).`,
    `Willingness to take risk: ${result.willingness_score}/100 (after a 30% drop they would: ${answerLabel('drop_reaction', answers.drop_reaction).toLowerCase()}; largest one-year drop they could live with: ${answerLabel('max_drop', answers.max_drop)}; experience: ${answerLabel('experience', answers.experience).toLowerCase()}).`,
    result.forced_cash
      ? 'They may need the money within 3 years, which always means the cash mix.'
      : `The final mix is the lower of the two (${result.limited_by === 'both' ? 'both point to the same level' : `limited by ${result.limited_by}`}).`,
    `Stock split preference: ${result.home_bias === 'more_canada' ? 'more Canada' : 'global market weight'}.`,
    'Write the explanation.',
  ].join('\n');
  return { system, user };
}

// The text out of whatever the LLM node returned (Anthropic or OpenAI node,
// simplified or raw). null when there is none, e.g. while the node is disabled
// and simply passes its input through.
function extractLlmText(json) {
  if (!json || typeof json !== 'object') return null;
  const fromParts = (parts) => {
    if (!Array.isArray(parts)) return null;
    const texts = [];
    for (const p of parts) {
      if (typeof p === 'string') texts.push(p);
      else if (p && typeof p.text === 'string') texts.push(p.text);
      else if (p && Array.isArray(p.content)) {
        const inner = fromParts(p.content);
        if (inner) texts.push(inner);
      }
    }
    return texts.length ? texts.join('\n').trim() : null;
  };
  if (typeof json.text === 'string' && json.text.trim()) return json.text.trim();
  if (typeof json.content === 'string' && json.content.trim()) return json.content.trim();
  if (typeof json.output === 'string' && json.output.trim()) return json.output.trim();
  if (typeof json.output_text === 'string' && json.output_text.trim()) return json.output_text.trim();
  if (json.message && typeof json.message.content === 'string' && json.message.content.trim()) return json.message.content.trim();
  if (Array.isArray(json.choices) && json.choices[0] && json.choices[0].message && typeof json.choices[0].message.content === 'string') {
    return json.choices[0].message.content.trim() || null;
  }
  return fromParts(json.content) || fromParts(json.output) || null;
}

// LLM text -> cleaned text, or null when it breaks the rules (then use the template).
function checkExplanation(text, symbols) {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/^["'“]+|["'”]+$/g, '').replace(/\s+/g, ' ').trim();
  if (t.length < 80 || t.length > 900) return null;
  const sentences = t.split(/[.!?](\s|$)/).filter((x) => x && x.trim().length > 1).length;
  if (sentences < 2 || sentences > 6) return null;
  const tickers = symbols && symbols.length ? symbols : ['VTI', 'VXUS', 'EWC', 'BND', 'SGOV'];
  if (tickers.some((sym) => new RegExp(`\\b${sym}\\b`).test(t))) return null;
  if (/\b(you should|we recommend|i recommend|we suggest)\b[^.]*\b(buy|sell|hold)\b/i.test(t)) return null;
  if (/\bguarantee/i.test(t)) return null;
  return t;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
}

// FNV-1a, 6 hex chars: a short, stable suffix for colliding user_ids.
function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 6);
}

// email -> user_id (spec §19.3: lowercase, URL-safe slug).
// 1. An existing user with this email keeps their user_id (retaking the quiz updates them).
// 2. Otherwise the slug of the email's local part: test-d@example.com -> test-d.
// 3. If that id is taken by someone else or protected (maya), add a hash of the email.
// `users` are rows from the users table ({user_id, email}).
function resolveUserId(email, users, protectedIds) {
  const prot = protectedIds || LO_PROTECTED_USER_IDS;
  const e = normalizeEmail(email);
  if (!isEmail(e)) throw new Error(`resolveUserId: invalid email ${email}`);
  const rows = Array.isArray(users) ? users : [];
  const match = rows.find((u) => u && u.user_id && normalizeEmail(u.email) === e && !prot.includes(u.user_id));
  if (match) return { user_id: match.user_id, is_new: false };
  const taken = new Set(rows.filter((u) => u && u.user_id).map((u) => u.user_id));
  let base = slugify(e.split('@')[0]) || 'user';
  if (prot.includes(base) || taken.has(base)) base = `${base}-${shortHash(e)}`;
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return { user_id: id, is_new: true };
}

// Budget prefill: the user's current budgets if they have any, else the defaults.
function budgetDefaults(existing) {
  const rows = Array.isArray(existing) ? existing : [];
  return LO_DEFAULT_BUDGETS.map((d) => {
    const row = rows.find((r) => r && r.category_key === d.category_key);
    const amount = row ? Number(row.weekly_amount) : NaN;
    return {
      category_key: d.category_key,
      label: d.label,
      weekly_amount: Number.isFinite(amount) && amount >= 0 ? amount : d.weekly_amount,
      active: row && row.active !== undefined && row.active !== null ? Boolean(row.active) : true,
    };
  });
}

// Budgets page values (budget_<key>) -> budgets rows. Invalid or negative -> the prefill.
function parseBudgets(formJson, userId, prefill) {
  const base = prefill || budgetDefaults([]);
  return base.map((b) => {
    const raw = formJson ? formJson[`budget_${b.category_key}`] : undefined;
    const n = raw === '' || raw === null || raw === undefined ? NaN : Number(raw);
    const amount = Number.isFinite(n) && n >= 0 ? loRound2(Math.min(n, LO_MAX_WEEKLY_BUDGET)) : b.weekly_amount;
    return { user_id: userId, category_key: b.category_key, label: b.label, weekly_amount: amount, active: b.active !== false };
  });
}

function parseBufferTarget(raw, fallback) {
  const n = raw === '' || raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? loRound2(Math.min(n, LO_MAX_BUFFER_TARGET)) : fallback;
}

// The consent checkbox comes back as an array of the ticked labels.
function consentGiven(raw) {
  if (Array.isArray(raw)) return raw.length > 0;
  return raw === true || raw === 'true';
}

// ---- n8n form pages (JSON-defined Form nodes) ----
// Field objects use the keys n8n accepts in a JSON-defined page; fieldName is the
// key the page returns.

function loEscapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function questionField(q) {
  return {
    fieldLabel: q.label,
    fieldName: q.key,
    fieldType: q.type,
    requiredField: true,
    fieldOptions: { values: q.options.map(([, label]) => ({ option: label })) },
  };
}

function questionFields(page) {
  return LO_QUESTIONS.filter((q) => q.page === page).map(questionField);
}

function budgetFields(prefill) {
  return prefill.map((b) => ({
    fieldLabel: `${b.label} (CAD per week)`,
    fieldName: `budget_${b.category_key}`,
    fieldType: 'number',
    requiredField: true,
    defaultValue: b.weekly_amount,
  }));
}

function resultFields(result, explanation, isNew) {
  const pct = allocationToPercents(result.allocation);
  const warnings = result.warning_messages.length
    ? `<p><strong>Worth knowing</strong></p><ul>${result.warning_messages.map((w) => `<li>${loEscapeHtml(w)}</li>`).join('')}</ul>`
    : '';
  const mixRows = LO_SLEEVES.map((s) => `<tr><td>${LO_SLEEVE_LABELS[s]}</td><td>${pct[s]}%</td></tr>`).join('');
  const html = [
    `<h3>Your mix: ${loEscapeHtml(result.tier_label)}</h3>`,
    `<p>${loEscapeHtml(explanation)}</p>`,
    `<p>Capacity for risk: <strong>${result.capacity_score}/100</strong> (${LO_TIER_INFO[result.capacity_tier].label}). Willingness: <strong>${result.willingness_score}/100</strong> (${LO_TIER_INFO[result.willingness_tier].label}). The mix uses the lower of the two${result.forced_cash ? ', and money needed within 3 years always stays in cash' : ''}.</p>`,
    `<table><thead><tr><th>Suggested mix</th><th></th></tr></thead><tbody>${mixRows}</tbody></table>`,
    warnings,
    `<p><em>${loEscapeHtml(LO_RESULT_NOTE)}</em></p>`,
  ].join('');
  const fields = [{ fieldType: 'html', elementName: 'result_summary', html }];
  for (const s of LO_SLEEVES) {
    fields.push({ fieldLabel: `${LO_SLEEVE_LABELS[s]} (%)`, fieldName: `alloc_${s}`, fieldType: 'number', requiredField: true, defaultValue: pct[s] });
  }
  fields.push({
    fieldLabel: result.warnings.includes('low_emergency_fund')
      ? 'Cash cushion target (CAD). Kept as cash before anything is invested; we suggest a bigger one for you.'
      : 'Cash cushion target (CAD). Kept as cash before anything is invested.',
    fieldName: 'buffer_target',
    fieldType: 'number',
    requiredField: true,
    defaultValue: result.suggested_buffer_target,
  });
  fields.push({
    fieldLabel: 'Standing consent',
    fieldName: 'consent',
    fieldType: 'checkbox',
    requiredField: false,
    fieldOptions: { values: [{ option: 'Invest my weekly leftover automatically (simulated paper trading). I can pause anytime.' }] },
  });
  fields.push({ fieldType: 'html', elementName: 'result_disclaimer', html: `<p><em>${isNew ? 'Percentages that do not add up to 100 are scaled to 100. ' : 'Saving replaces your previous profile and budgets. Percentages that do not add up to 100 are scaled to 100. '}${loEscapeHtml(LO_DISCLAIMER)}</em></p>` });
  return fields;
}

// ---- rows LO-01 writes ----
// New users get every column; an existing user (retaking the quiz) only gets the
// columns onboarding owns, so buffer_balance, carries and created_at survive.
function buildRows(input) {
  const { userId, isNew, name, email, consent, bufferTarget, answers, result, allocation, explanation, budgets, now } = input;
  const nowIso = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
  const user = {
    user_id: userId,
    email: normalizeEmail(email),
    name: String(name || '').trim(),
    status: consent ? 'active' : 'paused',
    buffer_target: bufferTarget,
  };
  if (consent) user.consent_at = nowIso;
  if (isNew) Object.assign(user, { created_at: nowIso }, LO_NEW_USER_DEFAULTS, { buffer_target: bufferTarget });
  const profile = {
    user_id: userId,
    answers_json: JSON.stringify(answers),
    capacity_score: result.capacity_score,
    willingness_score: result.willingness_score,
    tier: result.tier,
    home_bias: result.home_bias,
    allocation_json: JSON.stringify(allocation),
    explanation,
    updated_at: nowIso,
    warnings_json: JSON.stringify(result.warnings),
  };
  return { user, profile, budgets: budgets.map((b) => ({ ...b, user_id: userId })) };
}

export {
  LO_TIERS, LO_TIER_INFO, LO_EQUITY_SPLIT, LO_SLEEVES, LO_SLEEVE_LABELS, LO_DEFAULT_BUDGETS, LO_NEW_USER_DEFAULTS,
  LO_LOW_EF_BUFFER_TARGET, LO_PROTECTED_USER_IDS, LO_QUESTIONS, LO_CAPACITY, LO_WILLINGNESS, LO_WARNINGS,
  LO_DISCLAIMER, LO_RESULT_NOTE,
  answerValue, answerLabel, answersFromForm, capacityScore, willingnessScore, tierForScore, lowerTier, homeBias,
  warningsFor, allocationFor, allocationToPercents, normalizeAllocation, scoreProfile, mixPhrase,
  templateExplanation, explanationPrompt, extractLlmText, checkExplanation, normalizeEmail, isEmail, slugify, shortHash,
  resolveUserId, budgetDefaults, parseBudgets, parseBufferTarget, consentGiven, questionFields, budgetFields,
  resultFields, buildRows,
};
