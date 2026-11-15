// lib/allocate.mjs: invest + reconcile logic for LO-05 and LO-06
// (spec §6.9, §10 WF05/WF06, §11.5, §12, §19.2, §19.5).
//
// - sleeve weights from the profile (allocation_json, or tier + home bias)
// - CAD -> USD at a Frankfurter rate with the config fallback
// - split to the cent (largest remainder, total preserved), sleeves under
//   Alpaca's $1 minimum folded into the largest sleeve
// - request validation, Alpaca response handling, reconcile decisions
//
// Plain functions, no imports, so this pastes straight into an n8n Code node:
// LO-05 and LO-06 embed everything above the `export` line at the bottom
// (lib/allocate.test.mjs checks they stay identical).

const SLEEVES = ['equity_us', 'equity_intl', 'equity_ca', 'bonds', 'cash'];

// §11.5 asset mix per tier.
const TIER_MIX = {
  cash: { equity: 0, bonds: 0, cash: 1 },
  conservative: { equity: 0.2, bonds: 0.6, cash: 0.2 },
  balanced: { equity: 0.6, bonds: 0.4, cash: 0 },
  growth: { equity: 0.8, bonds: 0.2, cash: 0 },
  all_equity: { equity: 1, bonds: 0, cash: 0 },
};

// §11.5 equity split by home bias.
const HOME_BIAS_SPLIT = {
  global: { equity_us: 0.6, equity_intl: 0.35, equity_ca: 0.05 },
  more_canada: { equity_us: 0.45, equity_intl: 0.25, equity_ca: 0.3 },
};

const ALPACA_PAPER_URL = 'https://paper-api.alpaca.markets'; // paper only, never live (spec §0.6)
const MIN_NOTIONAL_USD = 1; // Alpaca: fractional orders from $1 notional
const CLIENT_ORDER_ID_MAX = 48; // Alpaca v2 limit (newer docs say 128; stay under the strict one)
const RETRY_SUFFIX = '-r1'; // spec §19.2
const TERMINAL_STATUSES = ['filled', 'canceled', 'expired', 'rejected', 'replaced'];
const FX_SANE_RANGE = [0.8, 2.0]; // CAD per 1 USD; anything outside is treated as a bad quote
const HTTP_FOR_CODE = { BAD_REQUEST: 400, NOT_FOUND: 404, UPSTREAM_ERROR: 502, INTERNAL: 500 };

// ---------- money ----------

// Dollars -> integer cents. toFixed(6) strips float noise (26.15 * 100 = 2614.9999…).
function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) throw new Error(`toCents: not a number: ${amount}`);
  return Math.round(Number((n * 100).toFixed(6)));
}

function round2(amount) {
  return toCents(amount) / 100;
}

function round4(x) {
  return Math.round(Number((Number(x) * 10000).toFixed(6))) / 10000;
}

// Split `totalCents` across `weights` (non-negative numbers) into integer cents
// that sum exactly to `totalCents`. Largest remainder: everyone gets the floor
// of their share, the leftover cents go to the largest fractional parts
// (ties: larger weight, then earlier position).
function splitCents(totalCents, weights) {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error(`splitCents: bad total ${totalCents}`);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw new Error('splitCents: weights sum to 0');
  const raw = weights.map((w) => (totalCents * w) / sum);
  const out = raw.map((r) => Math.floor(r + 1e-9));
  let left = totalCents - out.reduce((a, b) => a + b, 0);
  const rank = raw
    .map((r, i) => ({ i, frac: Number((r - out[i]).toFixed(9)), w: weights[i] }))
    .sort((a, b) => b.frac - a.frac || b.w - a.w || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % rank.length) {
    out[rank[k].i] += 1;
    left -= 1;
  }
  return out;
}

// ---------- weights ----------

// §11.5: tier + home bias -> sleeve weights (fractions summing to 1).
function sleeveWeights(tier, homeBias = 'global') {
  const mix = TIER_MIX[tier];
  if (!mix) throw new Error(`unknown tier: ${tier}`);
  const split = HOME_BIAS_SPLIT[homeBias] || HOME_BIAS_SPLIT.global;
  return {
    equity_us: round4(mix.equity * split.equity_us),
    equity_intl: round4(mix.equity * split.equity_intl),
    equity_ca: round4(mix.equity * split.equity_ca),
    bonds: mix.bonds,
    cash: mix.cash,
  };
}

// allocation_json (string or object) -> validated weights for every sleeve.
function parseWeights(allocation) {
  let obj = allocation;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      throw new Error('allocation_json is not valid JSON');
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('allocation must be an object of sleeve weights');
  const weights = {};
  let sum = 0;
  for (const [sleeve, value] of Object.entries(obj)) {
    if (!SLEEVES.includes(sleeve)) throw new Error(`allocation has an unknown sleeve: ${sleeve}`);
    const w = Number(value);
    if (!Number.isFinite(w) || w < 0) throw new Error(`allocation weight for ${sleeve} must be a number >= 0`);
    weights[sleeve] = w;
    sum += w;
  }
  if (Math.abs(sum - 1) > 0.01) throw new Error(`allocation weights sum to ${round4(sum)}, expected 1`);
  for (const s of SLEEVES) if (!(s in weights)) weights[s] = 0;
  return weights;
}

// The user's (possibly edited) allocation wins; tier + home bias only when the
// profile has none. An allocation that is present but broken is an error, not
// a silent fallback: we never invest differently from what the user chose.
function resolveWeights(profile) {
  const raw = profile && profile.allocation_json;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    return { weights: parseWeights(raw), source: 'profile' };
  }
  return { weights: sleeveWeights(profile && profile.tier, profile && profile.home_bias), source: 'tier' };
}

// ---------- FX ----------

// Frankfurter body {base:"USD", date, rates:{CAD}} -> CAD per 1 USD, else the
// config fallback (`fx_fallback_usdcad`). Rounded to 4 decimals, the rate we
// store on every order.
function pickFxRate(frankfurterBody, fallbackValue) {
  const inRange = (r) => Number.isFinite(r) && r >= FX_SANE_RANGE[0] && r <= FX_SANE_RANGE[1];
  const body = frankfurterBody && typeof frankfurterBody === 'object' ? frankfurterBody : {};
  const rate = Number(body.rates && body.rates.CAD);
  if ((body.base === undefined || body.base === 'USD') && inRange(rate)) {
    return { fx_rate: round4(rate), fx_source: 'frankfurter', fx_date: body.date || null };
  }
  const fallback = Number(fallbackValue);
  if (fallbackValue !== '' && fallbackValue !== null && fallbackValue !== undefined && inRange(fallback)) {
    return { fx_rate: round4(fallback), fx_source: 'fallback', fx_date: null };
  }
  throw new Error('no usable USD/CAD rate: Frankfurter failed and config fx_fallback_usdcad is missing or out of range');
}

// ---------- the split ----------

function clientOrderId(auditId, symbol) {
  const id = `${auditId}-${symbol}`;
  if (id.length + RETRY_SUFFIX.length > CLIENT_ORDER_ID_MAX) {
    throw new Error(`client_order_id ${id} is too long for Alpaca (max ${CLIENT_ORDER_ID_MAX} with the retry suffix)`);
  }
  return id;
}

function isRetryId(clientOrderIdValue) {
  return String(clientOrderIdValue || '').endsWith(RETRY_SUFFIX);
}

// investable CAD -> one order per sleeve (spec §10 WF05 step 3).
// 1. CAD split to the cent by weight (total preserved).
// 2. USD total = CAD total / fx, split in proportion to the CAD amounts (total preserved).
// 3. Any sleeve whose USD amount is under Alpaca's minimum is folded into the
//    largest sleeve, then step 2 is redone, until every order clears the minimum.
function allocate({ investable_cad, weights, fx_rate, symbols, audit_id, min_notional_usd = MIN_NOTIONAL_USD }) {
  const totalCad = toCents(investable_cad);
  if (!(totalCad > 0)) throw new Error('investable_cad must be greater than 0');
  const fx = Number(fx_rate);
  if (!(fx > 0)) throw new Error(`bad fx_rate: ${fx_rate}`);
  const minUsd = toCents(min_notional_usd);
  const w = parseWeights(weights);

  let sleeves = SLEEVES.filter((s) => w[s] > 0);
  const seen = new Set();
  for (const s of sleeves) {
    const sym = symbols && symbols[s];
    if (!sym || typeof sym !== 'string') throw new Error(`config sleeve_symbols has no ticker for sleeve ${s}`);
    if (seen.has(sym)) throw new Error(`config sleeve_symbols maps two sleeves to ${sym}`);
    seen.add(sym);
  }

  const cad = {};
  splitCents(totalCad, sleeves.map((s) => w[s])).forEach((c, i) => {
    cad[sleeves[i]] = c;
  });
  sleeves = sleeves.filter((s) => cad[s] > 0);
  const largest = sleeves
    .slice()
    .sort((a, b) => cad[b] - cad[a] || w[b] - w[a] || SLEEVES.indexOf(a) - SLEEVES.indexOf(b))[0];

  const totalUsd = Math.round(Number((totalCad / fx).toFixed(6)));
  const folded = [];
  let usd = {};
  for (;;) {
    usd = {};
    splitCents(totalUsd, sleeves.map((s) => cad[s])).forEach((c, i) => {
      usd[sleeves[i]] = c;
    });
    const small = sleeves.filter((s) => s !== largest && usd[s] < minUsd);
    if (!small.length) break;
    for (const s of small) {
      folded.push({ sleeve: s, symbol: symbols[s], notional_cad: cad[s] / 100, into: largest });
      cad[largest] += cad[s];
      delete cad[s];
    }
    sleeves = sleeves.filter((s) => !small.includes(s));
  }
  if (usd[largest] < minUsd) {
    throw new Error(`USD ${totalUsd / 100} is below Alpaca's minimum order of USD ${minUsd / 100}`);
  }

  return {
    investable_cad: totalCad / 100,
    fx_rate: fx,
    invested_cad: totalCad / 100,
    invested_usd: totalUsd / 100,
    orders: sleeves.map((s) => ({
      client_order_id: clientOrderId(audit_id, symbols[s]),
      symbol: symbols[s],
      sleeve: s,
      notional_cad: cad[s] / 100,
      notional_usd: usd[s] / 100,
    })),
    folded,
  };
}

// ---------- order statuses (spec §19.2) ----------

function isTerminalStatus(rawStatus) {
  return TERMINAL_STATUSES.includes(rawStatus);
}

// Raw Alpaca status -> API status: queued | partially_filled | filled | rejected | canceled.
function apiOrderStatus(rawStatus) {
  if (rawStatus === 'filled' || rawStatus === 'partially_filled' || rawStatus === 'rejected') return rawStatus;
  if (rawStatus === 'canceled' || rawStatus === 'expired') return 'canceled';
  return 'queued';
}

// ---------- envelopes (spec §19.2) ----------

function envelopeOk(data) {
  return { ok: true, data };
}

function envelopeError(code, message, data) {
  const env = { ok: false, error: { code, message } };
  if (data !== undefined) env.data = data;
  return env;
}

// What LO-05 returns to LO-04 (Execute Workflow): the `data` object, with
// `error` added when the run did not invest (contracts/webhooks.md).
function internalResult(envelope, request) {
  if (envelope.ok) return envelope.data;
  const req = request || {};
  const base = envelope.data || { audit_id: req.audit_id || null, user_id: req.user_id || null, status: 'failed' };
  return { ...base, error: envelope.error };
}

// ---------- Alpaca responses (n8n HTTP Request node, full response + never error) ----------

// n8n HTTP item -> {ok, status, body, error}. A request that never got an HTTP
// answer (missing credential, DNS, timeout) comes back as {error} with status 0.
function readHttp(json) {
  if (!json || typeof json !== 'object') return { ok: false, status: 0, body: null, error: 'no response' };
  if (json.statusCode === undefined) {
    const e = json.error;
    const msg = typeof e === 'string' ? e : (e && (e.message || e.description)) || 'request failed';
    return { ok: false, status: 0, body: null, error: String(msg) };
  }
  const status = Number(json.statusCode);
  const body = json.body === undefined ? null : json.body;
  const ok = status >= 200 && status < 300;
  let error = null;
  if (!ok) {
    const detail = body && typeof body === 'object' && body.message ? body.message : typeof body === 'string' ? body.slice(0, 200) : '';
    error = `HTTP ${status}${detail ? `: ${detail}` : ''}`;
  }
  return { ok, status, body, error };
}

// GET /v2/account -> can we trade? Missing credential, bad keys, network down
// or a blocked account all mean "not ready" (spec §19.5).
function accountReady(accountHttpJson) {
  const r = readHttp(accountHttpJson);
  if (!r.ok) {
    if (r.status === 0) return { ready: false, reason: `Alpaca not reachable or the "Alpaca Paper" credential is missing (${r.error})` };
    if (r.status === 401 || r.status === 403) return { ready: false, reason: `Alpaca refused the API keys (${r.error})` };
    return { ready: false, reason: `Alpaca account check failed (${r.error})` };
  }
  const acct = r.body || {};
  if (acct.status && acct.status !== 'ACTIVE') return { ready: false, reason: `Alpaca account status is ${acct.status}` };
  if (acct.trading_blocked || acct.account_blocked) return { ready: false, reason: 'Alpaca account is blocked from trading' };
  return { ready: true, reason: null };
}

// Alpaca timestamps carry micro/nanoseconds ("…09.123456789Z"): store plain ISO (ms, UTC).
function isoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).replace(/(\.\d{3})\d+/, '$1');
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Alpaca order object -> the columns we store (Alpaca sends numbers as strings).
function orderFieldsFromAlpaca(order) {
  const o = order || {};
  const num = (v) => {
    const n = Number(v);
    return v === null || v === undefined || v === '' || !Number.isFinite(n) ? 0 : n;
  };
  return {
    alpaca_order_id: o.id || '',
    status: o.status || '',
    filled_qty: num(o.filled_qty),
    filled_avg_price: num(o.filled_avg_price),
    submitted_at: isoOrNull(o.submitted_at || o.created_at),
    filled_at: isoOrNull(o.filled_at),
  };
}

// One planned order + its POST /v2/orders and GET /v2/orders:by_client_order_id
// answers -> placed or not. The lookup is the source of truth: a POST that
// failed (e.g. 422 because the client_order_id already exists) whose lookup
// finds the order is a duplicate, which counts as success (spec §10 WF05 step 5).
function placementResult(planned, postHttpJson, lookupHttpJson) {
  const post = readHttp(postHttpJson);
  const look = readHttp(lookupHttpJson);
  if (look.ok && look.body && look.body.client_order_id === planned.client_order_id) {
    return { ...planned, placed: true, duplicate: !post.ok, ...orderFieldsFromAlpaca(look.body), error: null };
  }
  if (post.ok && post.body && post.body.id) {
    return { ...planned, placed: true, duplicate: false, ...orderFieldsFromAlpaca(post.body), error: null };
  }
  return {
    ...planned,
    placed: false,
    duplicate: false,
    ...orderFieldsFromAlpaca(null),
    error: post.error || look.error || 'order not placed',
  };
}

// An orders-table row for a placed order (contracts/data-tables.md).
function orderRow(placed, ctx) {
  return {
    client_order_id: placed.client_order_id,
    audit_id: ctx.audit_id,
    user_id: ctx.user_id,
    symbol: placed.symbol,
    sleeve: placed.sleeve,
    notional_usd: placed.notional_usd,
    notional_cad: placed.notional_cad,
    fx_rate: ctx.fx_rate,
    alpaca_order_id: placed.alpaca_order_id,
    status: placed.status,
    filled_qty: placed.filled_qty,
    filled_avg_price: placed.filled_avg_price,
    submitted_at: placed.submitted_at,
    filled_at: placed.filled_at,
  };
}

// ---------- LO-05 ----------

function configMap(rows) {
  const cfg = {};
  for (const r of rows || []) if (r && r.key) cfg[r.key] = r.value;
  return cfg;
}

function sum2(values) {
  return values.reduce((a, v) => a + toCents(v), 0) / 100;
}

// Audit already invested: return what was placed, touch nothing (idempotent re-run).
function alreadyInvestedData(audit, rows, userId) {
  const mine = (rows || []).filter((r) => r.audit_id === audit.audit_id);
  const counted = mine.filter((r) => !isRetryId(r.client_order_id));
  return {
    audit_id: audit.audit_id,
    user_id: userId,
    status: 'invested',
    already_invested: true,
    fx_rate: counted.length ? Number(counted[0].fx_rate) : null,
    fx_source: 'previous_run',
    invested_cad: sum2(counted.map((r) => r.notional_cad)),
    invested_usd: sum2(counted.map((r) => r.notional_usd)),
    orders: mine.map((r) => ({
      client_order_id: r.client_order_id,
      symbol: r.symbol,
      sleeve: r.sleeve,
      notional_cad: round2(r.notional_cad),
      notional_usd: round2(r.notional_usd),
      status: apiOrderStatus(r.status),
      alpaca_status: r.status,
      duplicate: true,
    })),
  };
}

// Everything LO-05 decides before talking to Alpaca, as one pure function.
// Inputs are the webhook/Execute Workflow body and the rows the Data Table
// nodes read (null when missing). Returns:
//   { proceed: false, http_status, envelope }            -> reply now
//   { proceed: true, plan }                              -> check Alpaca, place plan.orders
function planInvest({ request, user, profile, audit, config, existingOrders, fxBody }) {
  const fail = (code, message, data) => ({ proceed: false, http_status: HTTP_FOR_CODE[code], envelope: envelopeError(code, message, data) });
  const req = request && typeof request === 'object' ? request : {};
  const user_id = String(req.user_id || '').trim();
  const audit_id = String(req.audit_id || '').trim();
  const dry_run = req.dry_run === true || req.dry_run === 'true';
  const amount = Number(req.investable_cad);
  const cfg = config || {};

  if (!user_id) return fail('BAD_REQUEST', 'user_id is required');
  if (!audit_id) return fail('BAD_REQUEST', 'audit_id is required');
  if (!audit_id.startsWith(`${user_id}-`)) return fail('BAD_REQUEST', `audit_id ${audit_id} does not belong to user ${user_id}`);
  if (req.investable_cad === undefined || req.investable_cad === null || req.investable_cad === '' || !Number.isFinite(amount) || amount <= 0) {
    return fail('BAD_REQUEST', 'investable_cad must be a number greater than 0');
  }
  if (!user) return fail('NOT_FOUND', `unknown user ${user_id}`);
  if (!profile) return fail('NOT_FOUND', `no investor profile for ${user_id}`);

  const base = String(cfg.alpaca_base_url || ALPACA_PAPER_URL).replace(/\/+$/, '');
  if (base !== ALPACA_PAPER_URL) return fail('INTERNAL', `config alpaca_base_url must be ${ALPACA_PAPER_URL} (paper trading only), got ${base}`);
  let symbols;
  try {
    symbols = JSON.parse(cfg.sleeve_symbols);
  } catch {
    return fail('INTERNAL', 'config sleeve_symbols is missing or not valid JSON');
  }

  if (!dry_run) {
    if (!audit) return fail('NOT_FOUND', `unknown audit ${audit_id}`);
    if (audit.user_id !== user_id) return fail('BAD_REQUEST', `audit ${audit_id} belongs to ${audit.user_id}, not ${user_id}`);
    if (audit.status === 'invested') return { proceed: false, http_status: 200, envelope: envelopeOk(alreadyInvestedData(audit, existingOrders, user_id)) };
    if (audit.status !== 'computed') return fail('BAD_REQUEST', `audit ${audit_id} is ${audit.status}; only computed audits can be invested`);
    if (user.status === 'paused') return fail('BAD_REQUEST', `investing is paused for ${user_id}`);
    if (!user.consent_at) return fail('BAD_REQUEST', `${user_id} has not given standing consent to invest`);
  }

  const maxWeekly = Number(user.max_weekly_invest) > 0 ? Number(user.max_weekly_invest) : 200;
  const minInvest = Number(user.min_invest) > 0 ? Number(user.min_invest) : 5;
  if (toCents(amount) > toCents(maxWeekly)) return fail('BAD_REQUEST', `investable_cad ${round2(amount)} is above max_weekly_invest ${maxWeekly}`);
  if (toCents(amount) < toCents(minInvest)) return fail('BAD_REQUEST', `investable_cad ${round2(amount)} is below min_invest ${minInvest}`);

  let weights;
  let allocation_source;
  try {
    ({ weights, source: allocation_source } = resolveWeights(profile));
  } catch (e) {
    return fail('BAD_REQUEST', `profile for ${user_id}: ${e.message}`);
  }

  // A re-run after a partial failure reuses the rate already on this audit's
  // orders, so the split (and every client_order_id's amount) is identical.
  const previous = (existingOrders || []).find((o) => o.audit_id === audit_id && !isRetryId(o.client_order_id) && Number(o.fx_rate) > 0);
  let fx;
  if (previous) {
    fx = { fx_rate: Number(previous.fx_rate), fx_source: 'previous_run', fx_date: null };
  } else {
    try {
      fx = pickFxRate(fxBody, cfg.fx_fallback_usdcad);
    } catch (e) {
      return fail('UPSTREAM_ERROR', e.message);
    }
  }

  let split;
  try {
    split = allocate({ investable_cad: amount, weights, fx_rate: fx.fx_rate, symbols, audit_id });
  } catch (e) {
    return fail('BAD_REQUEST', e.message);
  }

  const warnings = [];
  if (audit && audit.investable_cad !== undefined && audit.investable_cad !== null && toCents(audit.investable_cad) !== toCents(amount)) {
    warnings.push(`investable_cad ${round2(amount)} differs from the audit's ${round2(audit.investable_cad)}`);
  }

  const data = {
    audit_id,
    user_id,
    status: 'dry_run',
    fx_rate: fx.fx_rate,
    fx_source: fx.fx_source,
    invested_cad: split.invested_cad,
    invested_usd: split.invested_usd,
    allocation_source,
    orders: split.orders.map((o) => ({ ...o, status: 'dry_run', alpaca_status: null, duplicate: false })),
    folded: split.folded,
  };
  if (warnings.length) data.warnings = warnings;
  if (dry_run) return { proceed: false, http_status: 200, envelope: envelopeOk(data) };

  return {
    proceed: true,
    http_status: 200,
    plan: {
      ...data,
      status: 'pending',
      alpaca_base_url: ALPACA_PAPER_URL,
      pending_carry: Number(user.pending_carry) || 0,
      orders: split.orders,
    },
  };
}

// Alpaca not usable before any order was sent: behave like dry_run, report
// UPSTREAM_ERROR, leave the audit computed (spec §19.5).
function upstreamResult(plan, reason) {
  const { alpaca_base_url, pending_carry, ...data } = plan;
  return {
    http_status: 502,
    envelope: envelopeError('UPSTREAM_ERROR', `${reason}. No order was sent; the audit stays computed so a later run can invest.`, {
      ...data,
      status: 'dry_run',
      orders: plan.orders.map((o) => ({ ...o, status: 'dry_run', alpaca_status: null, duplicate: false })),
    }),
  };
}

// After placing: rows to upsert, the reply, and (when every order is placed)
// the user's new pending_carry (spec §10 WF05 step 6).
function finishInvest(plan, results) {
  const ctx = { audit_id: plan.audit_id, user_id: plan.user_id, fx_rate: plan.fx_rate };
  const placed = results.filter((r) => r.placed);
  const rows = placed.map((r) => orderRow(r, ctx));
  const allPlaced = placed.length === results.length && results.length > 0;
  const { alpaca_base_url, pending_carry, ...rest } = plan;
  const data = {
    ...rest,
    status: allPlaced ? 'invested' : 'partial',
    invested_cad: allPlaced ? plan.invested_cad : sum2(placed.map((r) => r.notional_cad)),
    invested_usd: allPlaced ? plan.invested_usd : sum2(placed.map((r) => r.notional_usd)),
    orders: results.map((r) => {
      const o = {
        client_order_id: r.client_order_id,
        symbol: r.symbol,
        sleeve: r.sleeve,
        notional_cad: r.notional_cad,
        notional_usd: r.notional_usd,
        status: r.placed ? apiOrderStatus(r.status) : 'failed',
        alpaca_status: r.placed ? r.status : null,
        duplicate: r.duplicate,
      };
      if (!r.placed) o.error = r.error;
      return o;
    }),
  };
  if (allPlaced) {
    return {
      rows,
      all_placed: true,
      http_status: 200,
      envelope: envelopeOk(data),
      pending_carry_after: Math.max(toCents(pending_carry) - toCents(plan.invested_cad), 0) / 100,
    };
  }
  const failed = results.filter((r) => !r.placed);
  return {
    rows,
    all_placed: false,
    http_status: 502,
    envelope: envelopeError(
      'UPSTREAM_ERROR',
      `${failed.length} of ${results.length} orders were not accepted by Alpaca (${failed.map((f) => `${f.symbol}: ${f.error}`).join('; ')}). ` +
        'Placed orders are recorded; the audit stays computed and a re-run retries the rest without duplicates.',
      data,
    ),
    pending_carry_after: null,
  };
}

// ---------- LO-06 ----------

// Orders still worth asking Alpaca about.
function pickOpenOrders(rows, userId) {
  return (rows || []).filter((r) => r && r.client_order_id && !isTerminalStatus(r.status) && (!userId || r.user_id === userId));
}

function sameValue(a, b) {
  const blank = (v) => v === null || v === undefined || v === '';
  if (typeof a === 'number' || typeof b === 'number') return (blank(a) ? 0 : Number(a)) === (blank(b) ? 0 : Number(b));
  if (blank(a) && blank(b)) return true;
  if (blank(a) || blank(b)) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (/^\d{4}-\d{2}-\d{2}T/.test(String(a)) && Number.isFinite(ta) && Number.isFinite(tb)) return Math.abs(ta - tb) < 1000;
  return String(a) === String(b);
}

// One open row + its GET /v2/orders:by_client_order_id answer -> what to do.
//   kind: updated | unchanged | missing (404) | error
//   patch: columns to write; retry: a `-r1` order to submit; alert: message for WF09.
function reconcileOrder(row, lookupHttpJson, knownClientOrderIds) {
  const look = readHttp(lookupHttpJson);
  if (!look.ok || !look.body || look.body.client_order_id !== row.client_order_id) {
    return { kind: look.status === 404 ? 'missing' : 'error', patch: null, retry: null, alert: null, error: look.error || 'lookup returned another order' };
  }
  const f = orderFieldsFromAlpaca(look.body);
  const patch = {};
  for (const k of ['alpaca_order_id', 'status', 'filled_qty', 'filled_avg_price', 'submitted_at', 'filled_at']) {
    if (k === 'submitted_at' && !f[k]) continue;
    if (!sameValue(row[k], f[k])) patch[k] = f[k];
  }
  let retry = null;
  let alert = null;
  if (f.status === 'rejected' && row.status !== 'rejected') {
    if (isRetryId(row.client_order_id)) {
      alert = `order ${row.client_order_id} (${row.symbol}) was rejected again after its one retry`;
    } else {
      const retryId = `${row.client_order_id}${RETRY_SUFFIX}`;
      if (!knownClientOrderIds || !knownClientOrderIds.has(retryId)) {
        retry = {
          client_order_id: retryId,
          audit_id: row.audit_id,
          user_id: row.user_id,
          symbol: row.symbol,
          sleeve: row.sleeve,
          notional_usd: round2(row.notional_usd),
          notional_cad: round2(row.notional_cad),
          fx_rate: Number(row.fx_rate),
        };
      }
    }
  }
  return { kind: Object.keys(patch).length ? 'updated' : 'unchanged', patch, retry, alert, error: null };
}

// All open rows + their lookups -> updates, retries, alerts and counts.
function planReconcile(openRows, lookupHttpJsons, allRows) {
  const known = new Set((allRows || []).map((r) => r.client_order_id));
  const updates = [];
  const retries = [];
  const alerts = [];
  const problems = [];
  openRows.forEach((row, i) => {
    const d = reconcileOrder(row, lookupHttpJsons[i], known);
    if (d.kind === 'updated') updates.push({ client_order_id: row.client_order_id, ...d.patch });
    if (d.kind === 'missing' || d.kind === 'error') problems.push({ client_order_id: row.client_order_id, error: d.error });
    if (d.retry) retries.push(d.retry);
    if (d.alert) alerts.push(d.alert);
  });
  return { checked: openRows.length, updates, retries, alerts, problems };
}

// Retry orders placed (or not) -> rows to write, final counts and alerts.
function finishReconcile(summary, retryResults) {
  const rows = [];
  const alerts = summary.alerts.slice();
  let retried = 0;
  (retryResults || []).forEach((r) => {
    if (r.placed) {
      retried += 1;
      rows.push(orderRow(r, { audit_id: r.audit_id, user_id: r.user_id, fx_rate: r.fx_rate }));
      if (r.status === 'rejected') alerts.push(`retry ${r.client_order_id} (${r.symbol}) was rejected immediately`);
    } else {
      alerts.push(`retry ${r.client_order_id} (${r.symbol}) could not be placed: ${r.error}`);
    }
  });
  const failedRetries = (retryResults || []).filter((r) => !r.placed).length;
  const data = {
    checked: summary.checked,
    updated: summary.updates.length,
    retried,
    failed: summary.problems.length + failedRetries,
  };
  if (summary.problems.length) data.problems = summary.problems;
  if (alerts.length) data.alerts = alerts;
  return { rows, alerts, envelope: envelopeOk(data) };
}

export {
  SLEEVES,
  TIER_MIX,
  HOME_BIAS_SPLIT,
  ALPACA_PAPER_URL,
  MIN_NOTIONAL_USD,
  CLIENT_ORDER_ID_MAX,
  RETRY_SUFFIX,
  TERMINAL_STATUSES,
  HTTP_FOR_CODE,
  toCents,
  round2,
  round4,
  splitCents,
  sleeveWeights,
  parseWeights,
  resolveWeights,
  pickFxRate,
  clientOrderId,
  isRetryId,
  allocate,
  isTerminalStatus,
  apiOrderStatus,
  envelopeOk,
  envelopeError,
  internalResult,
  readHttp,
  accountReady,
  isoOrNull,
  orderFieldsFromAlpaca,
  placementResult,
  orderRow,
  configMap,
  alreadyInvestedData,
  planInvest,
  upstreamResult,
  finishInvest,
  pickOpenOrders,
  sameValue,
  reconcileOrder,
  planReconcile,
  finishReconcile,
};
