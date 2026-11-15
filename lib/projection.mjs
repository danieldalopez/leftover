// lib/projection.mjs: read-side math for Leftover (Lane E: LO-08 Dashboard API, LO-07 Weekly Digest).
// Spec §6, §10 WF07/WF08, §13, §19.2; exact shapes in contracts/api.md + contracts/fixtures/.
//
// Plain functions, no imports, no npm, so this pastes straight into an n8n Code node
// (scripts/build-wf07-08.mjs embeds everything above the `export` line, after lib/week.mjs).
// Nothing here reads the clock or the network: callers pass `now`-derived values in, so
// every function is deterministic and unit-tested (lib/projection.test.mjs).
//
// Sections:
//   1. money, booleans, time formatting
//   2. projection math (FV, lifetime, streaks, "your choices")
//   3. GET /lo/api/summary
//   4. GET /lo/api/audits
//   5. GET /lo/api/portfolio (orders-derived positions, Alpaca prices/clock when available)
//   6. GET /lo/api/projection
//   7. POST /lo/api/settings
//   8. LO-07 digest (facts, LLM prompt + check, template fallback, email)
// Every `*Response` function returns { status, body } where body is the §19.2 envelope.

const LO_RATES_DEFAULT = [0.04, 0.06, 0.08];
const LO_HORIZONS = [10, 20, 30];
const LO_DEFAULT_RATE = 0.06;
const LO_PROJECTION_DISCLAIMER = 'Illustrative, not a prediction. Assumes a constant annual return; real returns vary and can be negative.';
const LO_FOOTER = 'Educational prototype using simulated (paper) trading. Not investment advice. Projections are illustrative.';
const LO_SLEEVE_ORDER = ['equity_us', 'equity_intl', 'equity_ca', 'bonds', 'cash'];
const LO_DEMO_USER = 'maya';

// ---------- 1. money, booleans, time formatting ----------

// Dollars -> integer cents, rounding half away from zero (immune to 1.005 * 100 = 100.4999…).
function toCents(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  const s = n < 0 ? -1 : 1;
  return s * Math.round(Math.abs(n) * 100 + 1e-6);
}
const fromCents = (c) => c / 100;
const round2 = (x) => fromCents(toCents(x));
function roundTo(x, decimals) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  const s = n < 0 ? -1 : 1;
  return (s * Math.round(Math.abs(n) * f + 1e-6)) / f;
}
const sumCents = (arr, f) => arr.reduce((a, x) => a + toCents(f(x)), 0);
const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : 0);

// Data Tables return booleans as true/false, SQLite as 1/0; tolerate strings too.
function toBool(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

// Data Table rows come with n8n's own `id`; keep only real rows (an empty `{}` item means
// "no rows", because the get nodes run with alwaysOutputData) and sort by insertion order.
function rowsOf(items, keyField) {
  return (items || [])
    .map((r) => (r && r.json ? r.json : r))
    .filter((r) => r && r[keyField] !== undefined && r[keyField] !== null && r[keyField] !== '')
    .sort((a, b) => num(a.id) - num(b.id));
}

function configMap(rows) {
  const out = {};
  for (const r of rows || []) if (r && r.key) out[r.key] = r.value === null || r.value === undefined ? '' : String(r.value);
  return out;
}

// SQLite stores dates as 'YYYY-MM-DD HH:MM:SS.sss' in UTC: a zone-less string is UTC.
function parseInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  let s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = `${s.replace(' ', 'T')}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Minutes east of UTC for `instant` in `tz` (Vancouver: -480 in winter, -420 in summer).
function tzOffsetMinutes(instant, tz = 'America/Vancouver') {
  const d = new Date(instant);
  const ms = Math.floor(d.getTime() / 1000) * 1000;
  const p = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms))) p[type] = value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - ms) / 60000);
}

const pad2 = (n) => String(n).padStart(2, '0');

// ISO 8601 with the local offset, no milliseconds: '2026-11-14T15:30:00-07:00'. null stays null.
function isoLocal(instant, tz = 'America/Vancouver') {
  const d = parseInstant(instant);
  if (!d) return null;
  const off = tzOffsetMinutes(d, tz);
  const local = new Date(Math.floor(d.getTime() / 1000) * 1000 + off * 60000);
  const a = Math.abs(off);
  return `${local.toISOString().slice(0, 19)}${off < 0 ? '-' : '+'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

// A local wall-clock time on a calendar date, as ISO with the offset in force then.
function localWallIso(ymd, hhmm, tz = 'America/Vancouver') {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, m);
  let t = wall - tzOffsetMinutes(wall, tz) * 60000;
  t = wall - tzOffsetMinutes(t, tz) * 60000;
  return isoLocal(new Date(t), tz);
}

function ok(data) {
  return { status: 200, body: { ok: true, data } };
}
function fail(status, code, message) {
  return { status, body: { ok: false, error: { code, message } } };
}

// user_id from a query or body: lowercase URL-safe slug (§19.3).
function cleanUserId(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function findUser(userRows, userId) {
  return userRows.find((u) => u.user_id === userId) || null;
}

// ---------- 2. projection math ----------

// FV = amount × (1 + r)^years, rounded to cents (spec §10 WF07).
function futureValue(amount, rate, years) {
  return round2(num(amount) * (1 + rate) ** years);
}

// "0.04" style keys, as in the fixtures.
const rateKey = (r) => String(r);

function parseRates(value) {
  const rates = String(value || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((r) => Number.isFinite(r) && r > 0 && r < 1);
  return rates.length ? rates : LO_RATES_DEFAULT.slice();
}

// { "0.04": [{ years, value_cad }, …], … }
function projectionTable(amount, rates = LO_RATES_DEFAULT, horizons = LO_HORIZONS) {
  const out = {};
  for (const r of rates) out[rateKey(r)] = horizons.map((years) => ({ years, value_cad: futureValue(amount, r, years) }));
  return out;
}

// Audit rows (Data Table) newest first by week_start.
function sortAuditsNewestFirst(audits) {
  return audits.slice().sort((a, b) => (String(a.week_start) < String(b.week_start) ? 1 : String(a.week_start) > String(b.week_start) ? -1 : 0));
}

// Σ investable_cad of audits with status `invested` (summary.lifetime, projection.lifetime).
function lifetimeContributions(audits) {
  const invested = audits.filter((a) => a.status === 'invested');
  return {
    invested_cad: fromCents(sumCents(invested, (a) => a.investable_cad)),
    weeks_invested: invested.length,
    weeks_audited: audits.length,
  };
}

function parseLines(linesJson) {
  let lines = linesJson;
  if (typeof lines === 'string') {
    try { lines = JSON.parse(lines); } catch { lines = []; }
  }
  if (!Array.isArray(lines)) return [];
  // contracts/data-tables.md uses planned/actual/under/over; accept *_cad too.
  return lines.filter((l) => l && l.category_key).map((l) => ({
    category_key: String(l.category_key),
    label: l.label ? String(l.label) : String(l.category_key),
    planned_cad: round2(l.planned ?? l.planned_cad),
    actual_cad: round2(l.actual ?? l.actual_cad),
    under_cad: round2(l.under ?? l.under_cad),
    over_cad: round2(l.over ?? l.over_cad),
  }));
}

// Categories in budget order, then any category that only appears in audit lines.
function categoryOrder(budgets, auditLines) {
  const order = [];
  const labels = {};
  for (const b of budgets) {
    if (!order.includes(b.category_key) && (toBool(b.active) || auditLines.some((l) => l.category_key === b.category_key))) {
      order.push(b.category_key);
      labels[b.category_key] = b.label || b.category_key;
    }
  }
  for (const l of auditLines) {
    if (!order.includes(l.category_key)) order.push(l.category_key);
    if (!labels[l.category_key]) labels[l.category_key] = l.label || l.category_key;
  }
  return { order, labels };
}

// Per category: weeks_under (actual ≤ planned), weeks_total, current_streak (consecutive
// under-weeks counting back from the newest audit), leftover_cad (Σ under_cad, gross).
// `audits` = API audits (lines parsed), newest first.
function categoryStreaks(apiAudits, budgets) {
  const withLines = apiAudits.filter((a) => a.lines.length);
  const allLines = withLines.flatMap((a) => a.lines);
  const { order, labels } = categoryOrder(budgets, allLines);
  return order.map((key) => {
    let weeksUnder = 0;
    let weeksTotal = 0;
    let streak = 0;
    let streakOpen = true;
    let leftover = 0;
    for (const a of withLines) {
      const l = a.lines.find((x) => x.category_key === key);
      if (!l) continue;
      weeksTotal += 1;
      leftover += toCents(l.under_cad);
      const under = toCents(l.actual_cad) <= toCents(l.planned_cad);
      if (under) weeksUnder += 1;
      if (streakOpen && under) streak += 1;
      else streakOpen = false;
    }
    return { category_key: key, label: labels[key], weeks_under: weeksUnder, weeks_total: weeksTotal, current_streak: streak, leftover_cad: fromCents(leftover) };
  });
}

// "Your choices": per category, gross leftover and its illustrative 30-year value per rate.
function yourChoices(streaks, rates = LO_RATES_DEFAULT) {
  return streaks
    .map((s, i) => ({ s, i }))
    .sort((a, b) => toCents(b.s.leftover_cad) - toCents(a.s.leftover_cad) || a.i - b.i)
    .map(({ s }) => {
      const fv = {};
      for (const r of rates) fv[rateKey(r)] = futureValue(s.leftover_cad, r, 30);
      return { category_key: s.category_key, label: s.label, weeks_under: s.weeks_under, weeks_total: s.weeks_total, leftover_cad: s.leftover_cad, fv_30y_cad: fv };
    });
}

// ---------- 3. GET /lo/api/summary ----------

// What counts toward a week (contracts/data-tables.md): not removed, a budget category_key,
// date inside the week, not superseded (no other row has pending_txn_id = this txn_id).
// Returns { [category_key]: { actual: cents, pending: cents } } for `budgetKeys`.
function weekSpend(transactions, weekStartYmd, weekEndYmd, budgetKeys) {
  const rows = transactions.filter((t) => t && t.txn_id);
  const superseded = new Set();
  for (const t of rows) if (t.pending_txn_id && String(t.pending_txn_id) !== String(t.txn_id)) superseded.add(String(t.pending_txn_id));
  const out = {};
  for (const k of budgetKeys) out[k] = { actual: 0, pending: 0 };
  for (const t of rows) {
    if (toBool(t.removed) || superseded.has(String(t.txn_id))) continue;
    const k = t.category_key;
    if (!Object.prototype.hasOwnProperty.call(out, k)) continue;
    const day = String(t.date).slice(0, 10);
    if (day < weekStartYmd || day > weekEndYmd) continue;
    const c = toCents(t.amount);
    out[k].actual += c;
    if (toBool(t.pending)) out[k].pending += c;
  }
  return out;
}

// One summary line. `daysElapsed` = Mon 1 … Sun 7.
function summaryLine(budget, spend, daysElapsed) {
  const planned = toCents(budget.weekly_amount);
  const actual = spend ? spend.actual : 0;
  const pending = spend ? spend.pending : 0;
  const ratio = planned > 0 ? actual / planned : 0;
  const over = Math.max(actual - planned, 0);
  const projected = Math.round((actual * 7) / Math.max(daysElapsed, 1));
  return {
    category_key: budget.category_key,
    label: budget.label || budget.category_key,
    planned_cad: fromCents(planned),
    actual_cad: fromCents(actual),
    pending_cad: fromCents(pending),
    remaining_cad: fromCents(Math.max(planned - actual, 0)),
    over_cad: fromCents(over),
    pct_used: planned > 0 ? roundTo(ratio, 2) : 0,
    state: over > 0 ? 'over' : ratio >= 0.8 ? 'near' : 'ok',
    projected_actual_cad: fromCents(projected),
    projected_under_cad: fromCents(Math.max(planned - projected, 0)),
  };
}

// input: { userId, users, budgets, transactions, audits, orders, config (rows), prices, clock, fx,
//          week: { week_start, week_end, days_left, next_audit_at }, asOf }
function summaryResponse(input) {
  const userId = cleanUserId(input.userId);
  if (!userId) return fail(400, 'BAD_REQUEST', 'user_id is required');
  const user = findUser(rowsOf(input.users, 'user_id'), userId);
  if (!user) return fail(404, 'NOT_FOUND', `No user with user_id '${userId}'`);
  const cfg = configMap(rowsOf(input.config, 'key'));
  const budgets = rowsOf(input.budgets, 'category_key').filter((b) => b.user_id === userId && toBool(b.active));
  const txns = rowsOf(input.transactions, 'txn_id').filter((t) => t.user_id === userId);
  const audits = sortAuditsNewestFirst(rowsOf(input.audits, 'audit_id').filter((a) => a.user_id === userId));
  const w = input.week;
  const spend = weekSpend(txns, w.week_start, w.week_end, budgets.map((b) => b.category_key));
  const daysElapsed = 8 - w.days_left;
  const lines = budgets.map((b) => summaryLine(b, spend[b.category_key], daysElapsed));
  const last = audits[0] || null;
  const portfolio = portfolioData({ ...input, userId, user }).totals;
  const fx = fxRate(input.fx, cfg);
  return ok({
    user_id: userId,
    name: user.name || userId,
    status: user.status || 'active',
    demo_mode: cfg.demo_mode === 'true',
    as_of: input.asOf,
    week: { week_start: w.week_start, week_end: w.week_end, days_left: w.days_left, next_audit_at: w.next_audit_at },
    lines,
    totals: {
      planned_cad: fromCents(sumCents(lines, (l) => l.planned_cad)),
      actual_cad: fromCents(sumCents(lines, (l) => l.actual_cad)),
      remaining_cad: fromCents(sumCents(lines, (l) => l.remaining_cad)),
      over_cad: fromCents(sumCents(lines, (l) => l.over_cad)),
      projected_leftover_cad: fromCents(sumCents(lines, (l) => l.projected_under_cad)),
    },
    buffer: {
      balance_cad: round2(user.buffer_balance),
      target_cad: round2(user.buffer_target),
      cushion_rate: num(user.cushion_rate),
      absorb_overspend: toBool(user.absorb_overspend),
    },
    lifetime: lifetimeContributions(audits),
    last_audit: last ? { audit_id: last.audit_id, week_start: String(last.week_start).slice(0, 10), status: last.status, investable_cad: round2(last.investable_cad) } : null,
    portfolio: { market_value_usd: portfolio.market_value_usd, market_value_cad: portfolio.market_value_cad, fx_rate_usdcad: fx.rate, queued_usd: portfolio.queued_usd },
  });
}

// ---------- 4. GET /lo/api/audits ----------

// Line with the largest under_cad (ties -> line order = budget order), or null.
function bestCategory(lines) {
  let best = null;
  for (const l of lines) if (toCents(l.under_cad) > 0 && (!best || toCents(l.under_cad) > toCents(best.under_cad))) best = l;
  return best ? { category_key: best.category_key, label: best.label, under_cad: best.under_cad } : null;
}

// Data Table audit row -> API audit (lines in budget order).
function apiAudit(row, budgetOrder = []) {
  const rank = (k) => {
    const i = budgetOrder.indexOf(k);
    return i < 0 ? budgetOrder.length : i;
  };
  const lines = parseLines(row.lines_json).map((l, i) => ({ l, i })).sort((a, b) => rank(a.l.category_key) - rank(b.l.category_key) || a.i - b.i).map(({ l }) => l);
  return {
    audit_id: row.audit_id,
    week_start: String(row.week_start).slice(0, 10),
    week_end: String(row.week_end || '').slice(0, 10),
    status: row.status,
    gross_surplus_cad: round2(row.gross_surplus),
    total_over_cad: round2(row.total_over),
    late_adj_cad: round2(row.late_adj),
    to_buffer_cad: round2(row.to_buffer),
    buffer_after_cad: round2(row.buffer_after),
    investable_cad: round2(row.investable_cad),
    pending_carry_after_cad: round2(row.pending_carry_after),
    best_category: bestCategory(lines),
    lines,
  };
}

function userAudits(input, userId) {
  const budgets = rowsOf(input.budgets, 'category_key').filter((b) => b.user_id === userId);
  const rows = sortAuditsNewestFirst(rowsOf(input.audits, 'audit_id').filter((a) => a.user_id === userId));
  const order = budgets.map((b) => b.category_key);
  return { budgets, rows, audits: rows.map((r) => apiAudit(r, order)) };
}

// input: { userId, users, budgets, audits }
function auditsResponse(input) {
  const userId = cleanUserId(input.userId);
  if (!userId) return fail(400, 'BAD_REQUEST', 'user_id is required');
  if (!findUser(rowsOf(input.users, 'user_id'), userId)) return fail(404, 'NOT_FOUND', `No user with user_id '${userId}'`);
  const { budgets, audits } = userAudits(input, userId);
  const invested = audits.filter((a) => a.status === 'invested');
  return ok({
    user_id: userId,
    audits,
    totals: {
      gross_surplus_cad: fromCents(sumCents(audits, (a) => a.gross_surplus_cad)),
      to_buffer_cad: fromCents(sumCents(audits, (a) => a.to_buffer_cad)),
      invested_cad: fromCents(sumCents(invested, (a) => a.investable_cad)),
      weeks_audited: audits.length,
      weeks_invested: invested.length,
    },
    streaks: categoryStreaks(audits, budgets).map(({ leftover_cad, ...s }) => s),
  });
}

// ---------- 5. GET /lo/api/portfolio ----------

// orders.status stores Alpaca's raw status; the API maps it (spec §19.2).
function mapOrderStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'filled' || s === 'partially_filled' || s === 'rejected') return s;
  if (s === 'canceled' || s === 'cancelled' || s === 'expired') return 'canceled';
  return 'queued';
}

function parseSleeveSymbols(value) {
  try {
    const m = JSON.parse(value || '{}');
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

// Frankfurter response -> { rate, source }; falls back to config fx_fallback_usdcad.
function fxRate(fxJson, cfg) {
  const r = fxJson && fxJson.rates ? Number(fxJson.rates.CAD) : NaN;
  if (Number.isFinite(r) && r > 0) return { rate: roundTo(r, 4), source: 'frankfurter' };
  const fb = Number(cfg && cfg.fx_fallback_usdcad);
  return { rate: Number.isFinite(fb) && fb > 0 ? roundTo(fb, 4) : 1.38, source: 'fallback' };
}

// Alpaca market data latest trades ({ trades: { VTI: { p } } }) or quotes -> { VTI: 338.4 }.
// Anything else (missing credential, network error item) -> {}.
function pricesFromAlpaca(json) {
  const out = {};
  if (json && json.trades && typeof json.trades === 'object') {
    for (const [sym, t] of Object.entries(json.trades)) if (t && Number(t.p) > 0) out[sym] = Number(t.p);
  }
  if (json && json.quotes && typeof json.quotes === 'object') {
    for (const [sym, q] of Object.entries(json.quotes)) {
      if (out[sym]) continue;
      const ap = Number(q && q.ap);
      const bp = Number(q && q.bp);
      if (ap > 0 && bp > 0) out[sym] = (ap + bp) / 2;
    }
  }
  return out;
}

// Alpaca GET /v2/clock -> { market_open, next_open }; unknown -> nulls.
function clockFromAlpaca(json) {
  if (json && typeof json.is_open === 'boolean') return { market_open: json.is_open, next_open: isoLocal(json.next_open) };
  return { market_open: null, next_open: null };
}

// One API order from an orders row.
function apiOrder(row, symbolToSleeve) {
  const status = mapOrderStatus(row.status);
  const open = status === 'queued' || status === 'partially_filled';
  const auditId = String(row.audit_id || '');
  const ws = /\d{4}-\d{2}-\d{2}$/.test(auditId) ? auditId.slice(-10) : null;
  return {
    client_order_id: row.client_order_id,
    audit_id: auditId,
    week_start: ws,
    symbol: row.symbol,
    sleeve: row.sleeve || symbolToSleeve[row.symbol] || null,
    notional_cad: round2(row.notional_cad),
    notional_usd: round2(row.notional_usd),
    fx_rate: roundTo(row.fx_rate, 4),
    status,
    alpaca_status: row.status ? String(row.status) : '',
    filled_qty: status === 'queued' ? 0 : roundTo(row.filled_qty, 9),
    filled_avg_price: status === 'queued' ? 0 : num(row.filled_avg_price),
    estimated_value_usd: open ? round2(row.notional_usd) : null,
    submitted_at: isoLocal(row.submitted_at),
    filled_at: status === 'queued' ? null : isoLocal(row.filled_at),
  };
}

// Per-user portfolio. The paper account is shared by every user, so positions are derived
// from the user's own orders (qty, cost basis, contributions); Alpaca only supplies prices
// (latest trade) and the market clock. Without Alpaca, price = last fill price and
// market_open / next_open are null.
// input: { userId, orders, config (rows), prices ({SYM: usd}), clock ({market_open,next_open}), fx (Frankfurter json), asOf }
function portfolioData(input) {
  const userId = cleanUserId(input.userId);
  const cfg = configMap(rowsOf(input.config, 'key'));
  const sleeves = parseSleeveSymbols(cfg.sleeve_symbols);
  const symbolToSleeve = {};
  for (const [sleeve, sym] of Object.entries(sleeves)) symbolToSleeve[sym] = sleeve;
  const fx = fxRate(input.fx, cfg);
  const prices = input.prices || {};
  const clock = input.clock || { market_open: null, next_open: null };
  const rows = rowsOf(input.orders, 'client_order_id').filter((o) => o.user_id === userId);
  const sleeveRank = (s) => {
    const i = LO_SLEEVE_ORDER.indexOf(s);
    return i < 0 ? LO_SLEEVE_ORDER.length : i;
  };
  const orders = rows.map((r) => ({ r, o: apiOrder(r, symbolToSleeve) }))
    .sort((a, b) => {
      const ta = parseInstant(a.r.submitted_at);
      const tb = parseInstant(b.r.submitted_at);
      const d = (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0);
      return d || (a.o.audit_id < b.o.audit_id ? 1 : a.o.audit_id > b.o.audit_id ? -1 : 0) || sleeveRank(a.o.sleeve) - sleeveRank(b.o.sleeve);
    })
    .map(({ o }) => o);

  const pos = {};
  for (const r of rows) {
    const status = mapOrderStatus(r.status);
    if (status !== 'filled' && status !== 'partially_filled') continue;
    const sym = r.symbol;
    const p = pos[sym] || (pos[sym] = { symbol: sym, sleeve: r.sleeve || symbolToSleeve[sym] || null, qty: 0, cost: 0, contributed: 0, lastFillAt: -Infinity, lastFillPrice: 0 });
    const qty = num(r.filled_qty);
    const price = num(r.filled_avg_price);
    p.qty += qty;
    p.cost += qty * price;
    if (status === 'filled') p.contributed += toCents(r.notional_cad);
    const t = parseInstant(r.filled_at);
    const tm = t ? t.getTime() : 0;
    if (price > 0 && tm >= p.lastFillAt) {
      p.lastFillAt = tm;
      p.lastFillPrice = price;
    }
  }
  const positions = Object.values(pos)
    .filter((p) => p.qty > 0)
    .sort((a, b) => sleeveRank(a.sleeve) - sleeveRank(b.sleeve) || (a.symbol < b.symbol ? -1 : 1))
    .map((p) => {
      const price = prices[p.symbol] > 0 ? prices[p.symbol] : p.lastFillPrice;
      const mvUsd = toCents(p.qty * price);
      const cost = toCents(p.cost);
      return {
        symbol: p.symbol,
        sleeve: p.sleeve,
        qty: roundTo(p.qty, 9),
        current_price_usd: round2(price),
        market_value_usd: fromCents(mvUsd),
        market_value_cad: round2(fromCents(mvUsd) * fx.rate),
        cost_basis_usd: fromCents(cost),
        contributed_cad: fromCents(p.contributed),
        unrealized_pl_usd: fromCents(mvUsd - cost),
      };
    });
  const live = orders.filter((o) => o.status !== 'rejected' && o.status !== 'canceled');
  const cost = sumCents(positions, (p) => p.cost_basis_usd);
  const mv = sumCents(positions, (p) => p.market_value_usd);
  return {
    user_id: userId,
    as_of: input.asOf,
    fx_rate_usdcad: fx.rate,
    fx_source: fx.source,
    market_open: clock.market_open,
    next_open: clock.next_open,
    totals: {
      contributed_cad: fromCents(sumCents(live, (o) => o.notional_cad)),
      cost_basis_usd: fromCents(cost),
      market_value_usd: fromCents(mv),
      market_value_cad: fromCents(sumCents(positions, (p) => p.market_value_cad)),
      unrealized_pl_usd: fromCents(mv - cost),
      unrealized_pl_pct: cost > 0 ? roundTo((mv - cost) / cost, 4) : 0,
      queued_usd: fromCents(sumCents(orders.filter((o) => o.status === 'queued'), (o) => o.notional_usd)),
    },
    positions,
    orders,
  };
}

// input: { userId, users, orders, config, prices, clock, fx, asOf }
function portfolioResponse(input) {
  const userId = cleanUserId(input.userId);
  if (!userId) return fail(400, 'BAD_REQUEST', 'user_id is required');
  if (!findUser(rowsOf(input.users, 'user_id'), userId)) return fail(404, 'NOT_FOUND', `No user with user_id '${userId}'`);
  return ok(portfolioData({ ...input, userId }));
}

// ---------- 6. GET /lo/api/projection ----------

// input: { userId, rate (query string), users, budgets, audits, config }
function projectionResponse(input) {
  const userId = cleanUserId(input.userId);
  if (!userId) return fail(400, 'BAD_REQUEST', 'user_id is required');
  if (!findUser(rowsOf(input.users, 'user_id'), userId)) return fail(404, 'NOT_FOUND', `No user with user_id '${userId}'`);
  const cfg = configMap(rowsOf(input.config, 'key'));
  const rates = parseRates(cfg.assumed_returns);
  let selected = rates.includes(LO_DEFAULT_RATE) ? LO_DEFAULT_RATE : rates[Math.floor(rates.length / 2)];
  if (input.rate !== undefined && input.rate !== null && input.rate !== '') {
    const want = Number(input.rate);
    const match = rates.find((r) => Math.abs(r - want) < 1e-9);
    if (match === undefined) return fail(400, 'BAD_REQUEST', `rate must be one of ${rates.join(', ')}`);
    selected = match;
  }
  const { budgets, audits } = userAudits(input, userId);
  const life = lifetimeContributions(audits);
  const lastInvested = audits.find((a) => a.status === 'invested') || null;
  return ok({
    user_id: userId,
    selected_rate: selected,
    rates,
    horizons_years: LO_HORIZONS.slice(),
    disclaimer: LO_PROJECTION_DISCLAIMER,
    lifetime: {
      contributed_cad: life.invested_cad,
      weeks_invested: life.weeks_invested,
      weekly_average_cad: life.weeks_invested ? round2(life.invested_cad / life.weeks_invested) : 0,
      by_rate: projectionTable(life.invested_cad, rates),
    },
    last_week: lastInvested ? { audit_id: lastInvested.audit_id, invested_cad: lastInvested.investable_cad, by_rate: projectionTable(lastInvested.investable_cad, rates) } : null,
    your_choices: yourChoices(categoryStreaks(audits, budgets), rates),
  });
}

// ---------- 7. POST /lo/api/settings ----------

function settingsData(user, budgets, onboardingUrl) {
  return {
    user_id: user.user_id,
    status: user.status || 'active',
    buffer_target_cad: round2(user.buffer_target),
    cushion_rate: num(user.cushion_rate),
    absorb_overspend: toBool(user.absorb_overspend),
    min_invest_cad: round2(user.min_invest),
    max_weekly_invest_cad: round2(user.max_weekly_invest),
    onboarding_url: onboardingUrl,
    budgets: budgets.map((b) => ({ category_key: b.category_key, label: b.label || b.category_key, weekly_amount_cad: round2(b.weekly_amount), active: toBool(b.active) })),
  };
}

const isNumberLike = (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
function parseBoolStrict(v) {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}

// Validates the body and returns what to write, or an error response.
// -> { error: {status, body} } | { user_patch: {…} | null, budget_patches: [{user_id, category_key, weekly_amount?, active?}] }
// input: { body, users, budgets }
function settingsPlan(input) {
  const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body : {};
  const userId = cleanUserId(body.user_id);
  if (!userId) return { error: fail(400, 'BAD_REQUEST', 'user_id is required') };
  const user = findUser(rowsOf(input.users, 'user_id'), userId);
  if (!user) return { error: fail(404, 'NOT_FOUND', `No user with user_id '${userId}'`) };
  const budgets = rowsOf(input.budgets, 'category_key').filter((b) => b.user_id === userId);
  const bad = (m) => ({ error: fail(400, 'BAD_REQUEST', m) });
  const patch = {};
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'paused') return bad("status must be 'active' or 'paused'");
    if (body.status !== user.status) patch.status = body.status;
  }
  if (body.buffer_target !== undefined) {
    if (!isNumberLike(body.buffer_target) || Number(body.buffer_target) < 0) return bad('buffer_target must be a number >= 0');
    if (toCents(body.buffer_target) !== toCents(user.buffer_target)) patch.buffer_target = round2(body.buffer_target);
  }
  if (body.cushion_rate !== undefined) {
    if (!isNumberLike(body.cushion_rate) || Number(body.cushion_rate) < 0 || Number(body.cushion_rate) > 1) return bad('cushion_rate must be between 0 and 1');
    if (Number(body.cushion_rate) !== num(user.cushion_rate)) patch.cushion_rate = Number(body.cushion_rate);
  }
  if (body.absorb_overspend !== undefined) {
    const v = parseBoolStrict(body.absorb_overspend);
    if (v === undefined) return bad('absorb_overspend must be true or false');
    if (v !== toBool(user.absorb_overspend)) patch.absorb_overspend = v;
  }
  const budgetPatches = [];
  if (body.budgets !== undefined) {
    if (!Array.isArray(body.budgets)) return bad('budgets must be an array');
    const seen = new Set();
    for (const entry of body.budgets) {
      if (!entry || typeof entry !== 'object') return bad('each budgets entry must be an object');
      const key = String(entry.category_key || '');
      const b = budgets.find((x) => x.category_key === key);
      if (!b) return bad(`unknown category_key '${key}' for user '${userId}'`);
      if (seen.has(key)) return bad(`category_key '${key}' appears twice`);
      seen.add(key);
      const amount = entry.weekly_amount !== undefined ? entry.weekly_amount : entry.weekly_amount_cad;
      const bp = {};
      if (amount !== undefined) {
        if (!isNumberLike(amount) || Number(amount) < 0) return bad(`weekly_amount for '${key}' must be a number >= 0`);
        if (toCents(amount) !== toCents(b.weekly_amount)) bp.weekly_amount = round2(amount);
      }
      if (entry.active !== undefined) {
        const v = parseBoolStrict(entry.active);
        if (v === undefined) return bad(`active for '${key}' must be true or false`);
        if (v !== toBool(b.active)) bp.active = v;
      }
      if (Object.keys(bp).length) budgetPatches.push({ user_id: userId, category_key: key, ...bp });
    }
  }
  return { user_id: userId, user_patch: Object.keys(patch).length ? patch : null, budget_patches: budgetPatches };
}

// input: { userId, users, budgets, onboardingUrl } (rows read after the writes)
function settingsResponse(input) {
  const userId = cleanUserId(input.userId);
  const user = findUser(rowsOf(input.users, 'user_id'), userId);
  if (!user) return fail(404, 'NOT_FOUND', `No user with user_id '${userId}'`);
  const budgets = rowsOf(input.budgets, 'category_key').filter((b) => b.user_id === userId);
  return ok(settingsData(user, budgets, input.onboardingUrl));
}

// Onboarding form URL from the webhook URL n8n saw ('http://host/webhook/lo/api/settings').
function onboardingUrlFrom(webhookUrl) {
  const base = String(webhookUrl || '').split('/webhook')[0] || 'http://localhost:5678';
  return `${base}/form/lo-onboarding`;
}

// ---------- 8. LO-07 digest ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(ymd) {
  const [, m, d] = String(ymd).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
function money(x) {
  const c = toCents(x);
  const s = (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${c < 0 ? '-' : ''}$${s}`;
}
function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const firstName = (name, fallback) => String(name || fallback || 'there').trim().split(/\s+/)[0];

// Everything the email talks about, from table rows. -> { facts } | { error: {status, body} }
// input: { userId, auditId?, users, audits, orders, config, prices, clock, fx, asOf }
function digestFacts(input) {
  const userId = cleanUserId(input.userId);
  if (!userId) return { error: fail(400, 'BAD_REQUEST', 'user_id is required') };
  const user = findUser(rowsOf(input.users, 'user_id'), userId);
  if (!user) return { error: fail(404, 'NOT_FOUND', `No user with user_id '${userId}'`) };
  const cfg = configMap(rowsOf(input.config, 'key'));
  const { audits } = userAudits({ ...input, budgets: input.budgets || [] }, userId);
  let audit = null;
  if (input.auditId) {
    audit = audits.find((a) => a.audit_id === input.auditId) || null;
    if (!audit) return { error: fail(404, 'NOT_FOUND', `No audit '${input.auditId}' for user '${userId}'`) };
  } else {
    audit = audits[0] || null;
    if (!audit) return { error: fail(404, 'NOT_FOUND', `No audit yet for user '${userId}'`) };
  }
  const rates = parseRates(cfg.assumed_returns);
  const p = portfolioData({ ...input, userId });
  const amount = audit.status === 'invested' || audit.status === 'computed' ? audit.investable_cad : 0;
  const life = lifetimeContributions(audits);
  const recipient = userId === LO_DEMO_USER && cfg.demo_email_to ? cfg.demo_email_to : user.email || '';
  return {
    facts: {
      user_id: userId,
      first_name: firstName(user.name, userId),
      audit_id: audit.audit_id,
      week_start: audit.week_start,
      week_end: audit.week_end,
      week_label: `${shortDate(audit.week_start)} to ${shortDate(audit.week_end)}`,
      status: audit.status,
      lines: audit.lines,
      categories_total: audit.lines.length,
      categories_under: audit.lines.filter((l) => toCents(l.actual_cad) <= toCents(l.planned_cad)).length,
      best_category: audit.best_category,
      over_lines: audit.lines.filter((l) => toCents(l.over_cad) > 0).map((l) => ({ label: l.label, over_cad: l.over_cad })),
      gross_surplus_cad: audit.gross_surplus_cad,
      total_over_cad: audit.total_over_cad,
      to_buffer_cad: audit.to_buffer_cad,
      buffer_after_cad: audit.buffer_after_cad,
      buffer_target_cad: round2(user.buffer_target),
      absorb_overspend: toBool(user.absorb_overspend),
      min_invest_cad: round2(user.min_invest),
      invested_cad: amount,
      pending_carry_after_cad: audit.pending_carry_after_cad,
      lifetime_invested_cad: life.invested_cad,
      weeks_invested: life.weeks_invested,
      portfolio: {
        market_value_cad: p.totals.market_value_cad,
        market_value_usd: p.totals.market_value_usd,
        queued_usd: p.totals.queued_usd,
        fx_rate_usdcad: p.fx_rate_usdcad,
        market_open: p.market_open,
      },
      rates,
      projection: amount > 0 ? projectionTable(amount, rates) : null,
      fv_30y_at_6_cad: amount > 0 ? futureValue(amount, rates.includes(LO_DEFAULT_RATE) ? LO_DEFAULT_RATE : rates[Math.floor(rates.length / 2)], 30) : 0,
      headline_rate: rates.includes(LO_DEFAULT_RATE) ? LO_DEFAULT_RATE : rates[Math.floor(rates.length / 2)],
      sent_to: recipient,
      dashboard_url: cfg.dashboard_url || '',
    },
  };
}

function digestSubject(f) {
  if (f.status === 'invested') return `Your week: ${money(f.invested_cad)} invested`;
  if (f.status === 'computed') return `Your week: ${money(f.invested_cad)} ready to invest`;
  if (f.status === 'carried') return `Your week: ${money(f.pending_carry_after_cad)} carried to next week`;
  if (f.status === 'skipped_paused') return 'Your week: investing is paused';
  return `Your week of ${f.week_label}`;
}

// Fixed fallback text (spec §19.5): warm, general, non-advisory, ~80-120 words.
function digestTemplate(f) {
  const s = [];
  s.push(`Hi ${f.first_name}, here is your week of ${f.week_label}.`);
  if (f.categories_total) {
    s.push(`You stayed within plan in ${f.categories_under} of ${f.categories_total} categories and left ${money(f.gross_surplus_cad)} unspent overall.`);
  } else {
    s.push('No category spending was audited this week.');
  }
  if (f.best_category) s.push(`${f.best_category.label} was your best category, coming in ${money(f.best_category.under_cad)} under plan.`);
  if (f.over_lines.length) {
    const names = listJoin(f.over_lines.map((l) => l.label));
    s.push(f.absorb_overspend
      ? `${names} went over by ${money(f.total_over_cad)} in total, and that came out of your cushion first.`
      : `${names} went over by ${money(f.total_over_cad)} in total.`);
  }
  if (f.status === 'skipped_paused') {
    s.push('Investing is paused, so nothing was invested and your cushion was left as it was.');
    s.push(`It still holds ${money(f.buffer_after_cad)} of its ${money(f.buffer_target_cad)} target, ready for a week that runs over.`);
    s.push(`You have invested ${money(f.lifetime_invested_cad)} so far, and you can resume from the dashboard settings whenever you are ready.`);
    s.push('Your budgets keep tracking in the meantime, so every week still counts toward the habit.');
  } else {
    if (toCents(f.to_buffer_cad) > 0) s.push(`${money(f.to_buffer_cad)} topped up your cushion, which now holds ${money(f.buffer_after_cad)} of its ${money(f.buffer_target_cad)} target.`);
    else s.push(`Your cushion holds ${money(f.buffer_after_cad)} of its ${money(f.buffer_target_cad)} target.`);
    if (f.status === 'invested') s.push(`${money(f.invested_cad)} was invested following the allocation you chose, bringing your total to ${money(f.lifetime_invested_cad)}.`);
    else if (f.status === 'computed') s.push(`${money(f.invested_cad)} is ready to invest following the allocation you chose; you have invested ${money(f.lifetime_invested_cad)} so far.`);
    else if (f.status === 'carried') s.push(`Because ${money(f.pending_carry_after_cad)} is below the ${money(f.min_invest_cad)} minimum, nothing was invested this week; it carries over and joins next week's amount. You have invested ${money(f.lifetime_invested_cad)} so far.`);
    if (f.invested_cad > 0) s.push(`Illustrative, not a prediction: at ${Math.round(f.headline_rate * 100)}% a year, this week's ${money(f.invested_cad)} could grow to about ${money(f.fv_30y_at_6_cad)} in 30 years. Real returns vary and can be negative.`);
    else s.push('Small weeks still count, because the habit of spending a little less is what grows over time.');
  }
  s.push('See you next Sunday.');
  return s.join(' ');
}

// LLM prompt (spec §10 WF07): 80-120 words, warm, no security recommendations,
// projections "illustrative, not a prediction", mention the best category.
function digestPrompt(f) {
  const system = [
    'You write the weekly email summary for Leftover, an educational budgeting prototype that invests the part of a weekly budget a user did not spend, using simulated (paper) trading.',
    'Write ONE warm, plain-language paragraph of 80 to 120 words, addressed to the user by first name.',
    'Rules:',
    '- Mention the best category this week by its exact label (if there is one).',
    '- Use the dollar amounts exactly as given. Do not invent numbers.',
    '- Never recommend buying, selling or holding any specific security, and never name tickers, funds or companies.',
    "- If you mention a future value, call it 'illustrative, not a prediction'.",
    '- No guarantees, no financial advice, no emojis, no markdown, no headings, no sign-off.',
    'Output only the paragraph.',
  ].join('\n');
  const facts = {
    first_name: f.first_name,
    week: f.week_label,
    status: f.status,
    categories_under_plan: `${f.categories_under} of ${f.categories_total}`,
    best_category: f.best_category ? `${f.best_category.label}, ${money(f.best_category.under_cad)} under plan` : 'none',
    went_over: f.over_lines.map((l) => `${l.label} by ${money(l.over_cad)}`),
    unspent_total: money(f.gross_surplus_cad),
    to_cushion: money(f.to_buffer_cad),
    cushion: `${money(f.buffer_after_cad)} of ${money(f.buffer_target_cad)} target`,
    invested_this_week: money(f.invested_cad),
    carried_to_next_week: money(f.status === 'carried' ? f.pending_carry_after_cad : 0),
    lifetime_invested: money(f.lifetime_invested_cad),
    illustrative_30y_value: f.invested_cad > 0 ? `${money(f.fv_30y_at_6_cad)} at ${Math.round(f.headline_rate * 100)}% a year` : 'n/a',
  };
  return { system, user: `Facts for this week (JSON):\n${JSON.stringify(facts, null, 2)}` };
}

// Is the LLM text usable? -> { ok, reason }
function checkDigestText(text, f) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'empty' };
  const n = wordCount(t);
  if (n < 60 || n > 160) return { ok: false, reason: `length ${n} words` };
  if (/\b(VTI|VXUS|EWC|BND|SGOV|ETF|ETFs)\b/.test(t)) return { ok: false, reason: 'names a security' };
  if (/\b(buy|sell|short|guarantee|guaranteed|guarantees)\b/i.test(t)) return { ok: false, reason: 'advice or guarantee wording' };
  if (/you should (invest|put|move)/i.test(t)) return { ok: false, reason: 'advice wording' };
  if (/\byears?\b/i.test(t) && !/illustrative/i.test(t)) return { ok: false, reason: 'projection not labelled illustrative' };
  if (f && f.best_category && !t.toLowerCase().includes(String(f.best_category.label).toLowerCase())) return { ok: false, reason: 'best category not mentioned' };
  if (/[#*`]/.test(t)) return { ok: false, reason: 'markdown' };
  return { ok: true, reason: '' };
}

// The full email: summary paragraph + scoreboard + numbers + projection + footer.
function digestEmail(f, summary) {
  const out = [summary, ''];
  if (f.lines.length) {
    out.push(`Scoreboard, ${f.week_label}`);
    const w = Math.max(...f.lines.map((l) => l.label.length));
    for (const l of f.lines) {
      const tail = toCents(l.over_cad) > 0 ? `over ${money(l.over_cad)}` : toCents(l.under_cad) > 0 ? `under ${money(l.under_cad)}` : 'on plan';
      out.push(`  ${l.label.padEnd(w)}  ${money(l.actual_cad)} of ${money(l.planned_cad)}  ${tail}`);
    }
    out.push('');
  }
  out.push(`Unspent this week: ${money(f.gross_surplus_cad)} (over: ${money(f.total_over_cad)})`);
  out.push(`To your cushion: ${money(f.to_buffer_cad)}. Cushion: ${money(f.buffer_after_cad)} of ${money(f.buffer_target_cad)}`);
  if (f.status === 'carried') out.push(`Invested this week: $0.00 (${money(f.pending_carry_after_cad)} carried to next week)`);
  else if (f.status === 'skipped_paused') out.push('Invested this week: $0.00 (investing paused)');
  else out.push(`Invested this week: ${money(f.invested_cad)} CAD${f.status === 'computed' ? ' (ready, not sent yet)' : ''}`);
  out.push(`Lifetime invested: ${money(f.lifetime_invested_cad)} CAD`);
  const pv = f.portfolio;
  let pline = `Portfolio value: ${money(pv.market_value_cad)} CAD (US${money(pv.market_value_usd)})`;
  if (toCents(pv.queued_usd) > 0) pline += `, plus US${money(pv.queued_usd)} queued${pv.market_open === false ? ' to fill at the next market open' : ''}`;
  out.push(pline);
  if (f.projection) {
    out.push('');
    out.push(`Illustrative, not a prediction: this week's ${money(f.invested_cad)} at a constant annual return`);
    for (const r of f.rates) {
      const rows = f.projection[rateKey(r)];
      out.push(`  ${Math.round(r * 100)}%: ${rows.map((x) => `${money(x.value_cad)} in ${x.years} years`).join(', ')}`);
    }
    out.push(`  ${LO_PROJECTION_DISCLAIMER}`);
  }
  if (f.dashboard_url) {
    out.push('');
    out.push(`Dashboard: ${f.dashboard_url}`);
  }
  out.push('');
  out.push(LO_FOOTER);
  return { subject: digestSubject(f), body: out.join('\n') };
}

// Picks the LLM text when it passes checkDigestText, else the template. -> { summary, source, reason }
function digestSummary(f, llmText) {
  const check = checkDigestText(llmText, f);
  if (check.ok) return { summary: String(llmText).trim(), source: 'llm', reason: '' };
  return { summary: digestTemplate(f), source: 'template', reason: llmText ? check.reason : 'llm unavailable' };
}

export {
  LO_RATES_DEFAULT, LO_HORIZONS, LO_DEFAULT_RATE, LO_PROJECTION_DISCLAIMER, LO_FOOTER, LO_SLEEVE_ORDER,
  toCents, fromCents, round2, roundTo, toBool, rowsOf, configMap, parseInstant, tzOffsetMinutes, isoLocal, localWallIso,
  ok, fail, cleanUserId,
  futureValue, rateKey, parseRates, projectionTable, lifetimeContributions, parseLines, categoryStreaks, yourChoices,
  weekSpend, summaryLine, summaryResponse,
  bestCategory, apiAudit, auditsResponse,
  mapOrderStatus, fxRate, pricesFromAlpaca, clockFromAlpaca, apiOrder, portfolioData, portfolioResponse,
  projectionResponse,
  settingsPlan, settingsResponse, settingsData, onboardingUrlFrom,
  money, wordCount, digestFacts, digestSubject, digestTemplate, digestPrompt, checkDigestText, digestEmail, digestSummary,
};
