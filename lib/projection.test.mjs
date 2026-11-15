// Tests for lib/projection.mjs. The big ones rebuild each contracts/fixtures/*.json from the
// Data Table rows it was made from (seed + the backfilled audits/orders) and require an exact match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seedDate, weekStart, weekEnd, daysLeft } from './week.mjs';
import {
  toCents, round2, isoLocal, localWallIso, parseInstant, futureValue, projectionTable, parseRates,
  weekSpend, summaryResponse, auditsResponse, portfolioResponse, projectionResponse, settingsPlan,
  settingsResponse, onboardingUrlFrom, mapOrderStatus, fxRate, pricesFromAlpaca, clockFromAlpaca,
  categoryStreaks, apiAudit, digestFacts, digestTemplate, digestPrompt, checkDigestText, digestEmail,
  digestSummary, wordCount, money, LO_FOOTER,
} from './projection.mjs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const seed = read('../demo/seed-data.json');
const fx = (name) => read(`../contracts/fixtures/${name}.json`);
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));

// "Now" in the fixtures: Sat 2026-11-14 15:30 Vancouver.
const NOW = new Date('2026-11-14T15:30:00-07:00');
const AS_OF = '2026-11-14T15:30:00-07:00';

// ---- Data Table rows the fixtures were made from ----
const configRows = seed.config.map(({ key, value }, i) => ({ id: i + 1, key, value }));
const budgetRows = seed.budgets.map((b, i) => ({ id: i + 1, ...b }));
const userRow = (over = {}) => ({
  id: 1, user_id: 'maya', email: 'maya@example.com', name: 'Maya', timezone: 'America/Vancouver', status: 'active',
  buffer_balance: 41, buffer_target: 100, cushion_rate: 0.5, absorb_overspend: true, min_invest: 5,
  max_weekly_invest: 200, pending_carry: 0, deficit_carry: 0, ...over,
});
const txnRows = seed.transactions.map(({ day_offset, _note, ...t }, i) => ({ id: i + 1, ...t, date: seedDate(day_offset, NOW), source: 'seed' }));
// audits fixture -> table rows (contract lines_json keys: planned/actual/under/over)
const auditRows = fx('audits').data.audits.slice().reverse().map((a, i) => ({
  id: i + 1, audit_id: a.audit_id, user_id: 'maya', week_start: a.week_start, week_end: a.week_end,
  lines_json: JSON.stringify(a.lines.map((l) => ({ category_key: l.category_key, label: l.label, planned: l.planned_cad, actual: l.actual_cad, under: l.under_cad, over: l.over_cad }))),
  gross_surplus: a.gross_surplus_cad, total_over: a.total_over_cad, late_adj: a.late_adj_cad, to_buffer: a.to_buffer_cad,
  buffer_after: a.buffer_after_cad, investable_cad: a.investable_cad, pending_carry_after: a.pending_carry_after_cad,
  status: a.status, created_at: '2026-11-15 04:00:00.000',
}));
// SQLite keeps dates as zone-less UTC strings: exercise that path.
const sqliteUtc = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').replace('Z', '') : null);
const orderRows = (fixtureName) => fx(fixtureName).data.orders.slice().reverse().map((o, i) => ({
  id: i + 1, client_order_id: o.client_order_id, audit_id: o.audit_id, user_id: 'maya', symbol: o.symbol, sleeve: o.sleeve,
  notional_usd: o.notional_usd, notional_cad: o.notional_cad, fx_rate: o.fx_rate, alpaca_order_id: `alp-${i}`,
  status: o.alpaca_status, filled_qty: o.filled_qty, filled_avg_price: o.filled_avg_price,
  submitted_at: sqliteUtc(o.submitted_at), filled_at: sqliteUtc(o.filled_at),
}));
const pricesOf = (fixtureName) => ({ trades: Object.fromEntries(fx(fixtureName).data.positions.map((p) => [p.symbol, { p: p.current_price_usd }])) });

const week = (now) => {
  const ws = weekStart(now);
  const we = weekEnd(ws);
  return { week_start: ws, week_end: we, days_left: daysLeft(now), next_audit_at: localWallIso(we, '20:00') };
};

// ---------- money and time ----------

test('toCents rounds half away from zero without float drift', () => {
  assert.equal(toCents(1.005), 101);
  assert.equal(toCents(0.515), 52);
  assert.equal(toCents(-2.5 / 100), -3);
  assert.equal(toCents('12.34'), 1234);
  assert.equal(toCents(null), 0);
  assert.equal(round2(48.066666), 48.07);
});

test('isoLocal and localWallIso use the Vancouver offset, across the DST change', () => {
  assert.equal(isoLocal('2026-11-14T22:30:00Z'), '2026-11-14T15:30:00-07:00');
  assert.equal(isoLocal('2026-10-26 13:30:02.000'), '2026-10-26T06:30:02-07:00'); // SQLite UTC string, PDT
  assert.equal(isoLocal('2026-11-16T09:30:00-05:00'), '2026-11-16T07:30:00-07:00'); // US open 9:30 EST = 7:30 in Vancouver now
  assert.equal(isoLocal(null), null);
  assert.equal(isoLocal(''), null);
  assert.equal(localWallIso('2026-11-15', '20:00'), '2026-11-15T20:00:00-07:00');
  assert.equal(localWallIso('2026-11-01', '20:00'), '2026-11-01T20:00:00-07:00'); // BC: permanent UTC-7 from 02:00 that day (tz 2026c+)
  assert.equal(localWallIso('2025-11-02', '20:00'), '2025-11-02T20:00:00-08:00'); // the last real fall-back
  assert.equal(localWallIso('2026-10-25', '20:00'), '2026-10-25T20:00:00-07:00');
  assert.equal(parseInstant('nonsense'), null);
});

// ---------- projection math ----------

test('futureValue = amount x (1+r)^years, to the cent (spec §10 WF07, §6.8 $13)', () => {
  assert.equal(futureValue(98.58, 0.06, 30), 566.19);
  assert.equal(futureValue(26.15, 0.08, 30), 263.14);
  assert.equal(futureValue(13, 0.06, 30), 74.67);
  assert.equal(futureValue(0, 0.06, 30), 0);
  const t = projectionTable(98.58);
  assert.deepEqual(Object.keys(t), ['0.04', '0.06', '0.08']);
  assert.deepEqual(t['0.04'], fx('projection').data.lifetime.by_rate['0.04']);
});

test('parseRates reads config assumed_returns and falls back to 4/6/8%', () => {
  assert.deepEqual(parseRates('0.04,0.06,0.08'), [0.04, 0.06, 0.08]);
  assert.deepEqual(parseRates(' 0.05 , 0.07'), [0.05, 0.07]);
  assert.deepEqual(parseRates(''), [0.04, 0.06, 0.08]);
  assert.deepEqual(parseRates('abc,2'), [0.04, 0.06, 0.08]);
});

test('streaks: weeks_under counts actual <= planned, current_streak counts back from the newest', () => {
  const audits = auditRows.slice().reverse().map((r) => apiAudit(r, budgetRows.map((b) => b.category_key)));
  const s = categoryStreaks(audits, budgetRows);
  const by = Object.fromEntries(s.map((x) => [x.category_key, x]));
  assert.deepEqual([by.shopping.weeks_under, by.shopping.current_streak, by.shopping.leftover_cad], [2, 0, 61.01]);
  assert.deepEqual([by.entertainment.weeks_under, by.entertainment.current_streak], [2, 1]); // 40 of 40 counts as under
  assert.deepEqual([by.transport.weeks_under, by.transport.current_streak], [3, 3]);
  assert.deepEqual(categoryStreaks([], budgetRows).map((x) => x.weeks_total), [0, 0, 0, 0, 0, 0, 0]);
});

// ---------- summary ----------

test('weekSpend: refunds net, pending counts, superseded/removed/excluded/out-of-week never count', () => {
  const rows = [
    { txn_id: 'a', category_key: 'groceries', date: '2026-11-10', amount: 40, pending: false },
    { txn_id: 'b', category_key: 'groceries', date: '2026-11-11', amount: -5, pending: false },
    { txn_id: 'p', category_key: 'transport', date: '2026-11-11', amount: 6, pending: true },
    { txn_id: 'q', category_key: 'transport', date: '2026-11-12', amount: 6.25, pending: false, pending_txn_id: 'p' },
    { txn_id: 'r', category_key: 'transport', date: '2026-11-12', amount: 3, pending: true },
    { txn_id: 'x', category_key: 'excluded', date: '2026-11-10', amount: 1200 },
    { txn_id: 'y', category_key: 'groceries', date: '2026-11-10', amount: 99, removed: true },
    { txn_id: 'z', category_key: 'groceries', date: '2026-11-08', amount: 77 },
    { txn_id: 'w', category_key: 'groceries', date: '2026-11-16', amount: 77 },
  ];
  const s = weekSpend(rows, '2026-11-09', '2026-11-15', ['groceries', 'transport']);
  assert.deepEqual(s, { groceries: { actual: 3500, pending: 0 }, transport: { actual: 925, pending: 300 } });
});

test('summary rebuilds contracts/fixtures/summary.json from the seed rows', () => {
  const res = summaryResponse({
    userId: 'maya', users: [userRow()], budgets: budgetRows, transactions: txnRows, audits: auditRows,
    orders: orderRows('portfolio'), config: configRows, prices: pricesFromAlpaca(pricesOf('portfolio')),
    clock: clockFromAlpaca({ is_open: false, next_open: '2026-11-16T09:30:00-05:00' }),
    fx: { rates: { CAD: 1.3826 } }, week: week(NOW), asOf: AS_OF,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, fx('summary'));
});

test('summary is empty-safe: no audits, no orders, no transactions, Alpaca and FX down', () => {
  const res = summaryResponse({
    userId: 'maya', users: [userRow({ buffer_balance: 0 })], budgets: budgetRows, transactions: [{}], audits: [{}],
    orders: [{}], config: configRows, prices: pricesFromAlpaca({ error: { message: 'no credentials' } }),
    clock: clockFromAlpaca({ error: {} }), fx: { error: {} }, week: week(NOW), asOf: AS_OF,
  });
  const d = res.body.data;
  assert.equal(d.lines.length, 7);
  assert.equal(d.totals.actual_cad, 0);
  assert.equal(d.totals.projected_leftover_cad, 280);
  assert.equal(d.last_audit, null);
  assert.deepEqual(d.lifetime, { invested_cad: 0, weeks_invested: 0, weeks_audited: 0 });
  assert.deepEqual(d.portfolio, { market_value_usd: 0, market_value_cad: 0, fx_rate_usdcad: 1.42, queued_usd: 0 });
  assert.deepEqual(Object.keys(d), Object.keys(fx('summary').data));
});

test('summary line states: ok < 0.8 <= near <= 1.0 < over; planned 0 is safe', () => {
  const day7 = { week_start: '2026-11-09', week_end: '2026-11-15', days_left: 1, next_audit_at: 'x' };
  const mk = (amount, weekly = 50) => summaryResponse({
    userId: 'u', users: [{ user_id: 'u' }], budgets: [{ user_id: 'u', category_key: 'c', label: 'C', weekly_amount: weekly, active: true }],
    transactions: [{ txn_id: 't', user_id: 'u', category_key: 'c', date: '2026-11-10', amount }], audits: [], orders: [], config: [], week: day7, asOf: AS_OF,
  }).body.data.lines[0];
  assert.equal(mk(39.99).state, 'ok');
  assert.equal(mk(40).state, 'near');
  assert.equal(mk(50).state, 'near');
  assert.equal(mk(50.01).state, 'over');
  assert.equal(mk(10, 0).pct_used, 0);
  assert.equal(mk(10, 0).state, 'over');
  assert.equal(mk(20).projected_actual_cad, 20); // Sunday: pace = actual
});

test('errors: missing user_id is 400, unknown user is 404 (contracts/fixtures/error.json)', () => {
  const base = { users: [userRow()], budgets: [], transactions: [], audits: [], orders: [], config: [], week: week(NOW), asOf: AS_OF };
  assert.equal(summaryResponse({ ...base, userId: '' }).status, 400);
  const nf = summaryResponse({ ...base, userId: 'mya' });
  assert.equal(nf.status, 404);
  assert.deepEqual(nf.body, fx('error'));
  assert.equal(auditsResponse({ ...base, userId: 'nobody' }).status, 404);
  assert.equal(portfolioResponse({ ...base, userId: 'nobody' }).status, 404);
  assert.equal(projectionResponse({ ...base, userId: 'nobody' }).status, 404);
});

// ---------- audits ----------

test('audits rebuilds contracts/fixtures/audits.json', () => {
  const res = auditsResponse({ userId: 'maya', users: [userRow()], budgets: budgetRows, audits: auditRows });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, fx('audits'));
});

test('audits: best_category null when nothing is under, ties go to budget order, *_cad lines accepted', () => {
  const lines = [
    { category_key: 'b', label: 'B', planned_cad: 10, actual_cad: 5, under_cad: 5, over_cad: 0 },
    { category_key: 'a', label: 'A', planned_cad: 10, actual_cad: 5, under_cad: 5, over_cad: 0 },
  ];
  const a = apiAudit({ audit_id: 'u-2026-11-02', week_start: '2026-11-02', week_end: '2026-11-08', status: 'invested', lines_json: JSON.stringify(lines) }, ['a', 'b']);
  assert.equal(a.best_category.category_key, 'a');
  const none = apiAudit({ audit_id: 'x', week_start: '2026-11-02', status: 'skipped_paused', lines_json: '' }, []);
  assert.equal(none.best_category, null);
  assert.deepEqual(none.lines, []);
  assert.equal(none.gross_surplus_cad, 0);
});

// ---------- portfolio ----------

test('order status mapping (spec §19.2)', () => {
  assert.equal(mapOrderStatus('filled'), 'filled');
  assert.equal(mapOrderStatus('partially_filled'), 'partially_filled');
  assert.equal(mapOrderStatus('rejected'), 'rejected');
  assert.equal(mapOrderStatus('canceled'), 'canceled');
  assert.equal(mapOrderStatus('expired'), 'canceled');
  for (const s of ['new', 'accepted', 'pending_new', 'accepted_for_bidding', '', null]) assert.equal(mapOrderStatus(s), 'queued');
});

test('portfolio rebuilds contracts/fixtures/portfolio.json (all filled)', () => {
  const res = portfolioResponse({
    userId: 'maya', users: [userRow()], orders: orderRows('portfolio'), config: configRows,
    prices: pricesFromAlpaca(pricesOf('portfolio')), clock: clockFromAlpaca({ is_open: false, next_open: '2026-11-16T09:30:00-05:00' }),
    fx: { rates: { CAD: 1.3826 } }, asOf: AS_OF,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, fx('portfolio'));
});

test('portfolio rebuilds contracts/fixtures/portfolio-queued.json (Sunday night, market closed)', () => {
  const res = portfolioResponse({
    userId: 'maya', users: [userRow()], orders: orderRows('portfolio-queued'), config: configRows,
    prices: pricesFromAlpaca(pricesOf('portfolio-queued')), clock: clockFromAlpaca({ is_open: false, next_open: '2026-11-09T09:30:00-05:00' }),
    fx: { rates: { CAD: 1.381 } }, asOf: '2026-11-08T20:01:00-07:00',
  });
  assert.deepEqual(res.body, strip(fx('portfolio-queued')));
});

test('portfolio without Alpaca: last fill price, market_open/next_open null, FX fallback', () => {
  const d = portfolioResponse({
    userId: 'maya', users: [userRow()], orders: orderRows('portfolio-queued'), config: configRows,
    prices: pricesFromAlpaca({ error: { message: 'Credentials not found' } }), clock: clockFromAlpaca({ error: {} }), fx: { error: {} }, asOf: AS_OF,
  }).body.data;
  assert.equal(d.market_open, null);
  assert.equal(d.next_open, null);
  assert.equal(d.fx_source, 'fallback');
  assert.equal(d.fx_rate_usdcad, 1.42);
  const vti = d.positions.find((p) => p.symbol === 'VTI');
  assert.equal(vti.current_price_usd, 333.85); // last fill (2026-11-02)
  assert.equal(d.totals.queued_usd, 18.94);
  assert.equal(d.orders.filter((o) => o.status === 'queued').every((o) => o.estimated_value_usd === o.notional_usd && o.filled_at === null), true);
});

test('portfolio: rejected and canceled orders never count as contributed or held', () => {
  const rows = [
    { client_order_id: 'u-2026-11-02-VTI', audit_id: 'u-2026-11-02', user_id: 'u', symbol: 'VTI', sleeve: 'equity_us', notional_usd: 7, notional_cad: 10, fx_rate: 1.4, status: 'rejected', filled_qty: 0, filled_avg_price: 0, submitted_at: '2026-11-08T20:00:00-07:00' },
    { client_order_id: 'u-2026-11-02-BND', audit_id: 'u-2026-11-02', user_id: 'u', symbol: 'BND', sleeve: 'bonds', notional_usd: 7, notional_cad: 10, fx_rate: 1.4, status: 'expired', filled_qty: 0, filled_avg_price: 0, submitted_at: '2026-11-08T20:00:00-07:00' },
  ];
  const d = portfolioResponse({ userId: 'u', users: [{ user_id: 'u' }], orders: rows, config: configRows, asOf: AS_OF }).body.data;
  assert.equal(d.totals.contributed_cad, 0);
  assert.deepEqual(d.positions, []);
  assert.deepEqual(d.orders.map((o) => [o.status, o.estimated_value_usd]), [['rejected', null], ['canceled', null]]);
});

test('fxRate and Alpaca parsers tolerate error items', () => {
  assert.deepEqual(fxRate({ amount: 1, base: 'USD', rates: { CAD: 1.42581 } }, {}), { rate: 1.4258, source: 'frankfurter' });
  assert.deepEqual(fxRate(undefined, { fx_fallback_usdcad: '1.37' }), { rate: 1.37, source: 'fallback' });
  assert.deepEqual(pricesFromAlpaca({ quotes: { VTI: { ap: 10, bp: 9 } } }), { VTI: 9.5 });
  assert.deepEqual(pricesFromAlpaca(null), {});
  assert.deepEqual(clockFromAlpaca({ is_open: true, next_open: '2026-11-16T09:30:00-05:00' }), { market_open: true, next_open: '2026-11-16T07:30:00-07:00' });
});

// ---------- projection ----------

test('projection rebuilds contracts/fixtures/projection.json', () => {
  const res = projectionResponse({ userId: 'maya', rate: '0.06', users: [userRow()], budgets: budgetRows, audits: auditRows, config: configRows });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, fx('projection'));
});

test('projection: rate selects, bad rate is 400, empty history is safe', () => {
  const base = { userId: 'maya', users: [userRow()], budgets: budgetRows, audits: [], config: configRows };
  assert.equal(projectionResponse({ ...base, rate: '0.08' }).body.data.selected_rate, 0.08);
  assert.equal(projectionResponse({ ...base }).body.data.selected_rate, 0.06);
  assert.equal(projectionResponse({ ...base, rate: '0.07' }).status, 400);
  const d = projectionResponse(base).body.data;
  assert.equal(d.last_week, null);
  assert.equal(d.lifetime.weekly_average_cad, 0);
  assert.deepEqual(d.lifetime.by_rate['0.06'], [{ years: 10, value_cad: 0 }, { years: 20, value_cad: 0 }, { years: 30, value_cad: 0 }]);
  assert.equal(d.your_choices.length, 7);
});

// ---------- settings ----------

test('settings rebuilds contracts/fixtures/settings.json', () => {
  const res = settingsResponse({ userId: 'maya', users: [userRow()], budgets: budgetRows, onboardingUrl: onboardingUrlFrom('http://localhost:5678/webhook/lo/api/settings') });
  assert.deepEqual(res.body, fx('settings'));
});

test('settingsPlan: only real changes become patches; no-op writes nothing', () => {
  const base = { users: [userRow()], budgets: budgetRows };
  assert.deepEqual(settingsPlan({ ...base, body: { user_id: 'maya' } }), { user_id: 'maya', user_patch: null, budget_patches: [] });
  assert.deepEqual(settingsPlan({ ...base, body: { user_id: 'maya', status: 'active', cushion_rate: 0.5, budgets: [{ category_key: 'groceries', weekly_amount: 80 }] } }).budget_patches, []);
  const p = settingsPlan({ ...base, body: { user_id: 'Maya', status: 'paused', buffer_target: '120', absorb_overspend: false, budgets: [{ category_key: 'eating_out', weekly_amount: 45 }, { category_key: 'other', active: false }] } });
  assert.deepEqual(p.user_patch, { status: 'paused', buffer_target: 120, absorb_overspend: false });
  assert.deepEqual(p.budget_patches, [
    { user_id: 'maya', category_key: 'eating_out', weekly_amount: 45 },
    { user_id: 'maya', category_key: 'other', active: false },
  ]);
});

test('settingsPlan validation -> 400 BAD_REQUEST / 404 NOT_FOUND', () => {
  const base = { users: [userRow()], budgets: budgetRows };
  const code = (body) => {
    const r = settingsPlan({ ...base, body });
    return r.error ? `${r.error.status} ${r.error.body.error.code}` : 'ok';
  };
  assert.equal(code({}), '400 BAD_REQUEST');
  assert.equal(code({ user_id: 'ghost' }), '404 NOT_FOUND');
  assert.equal(code({ user_id: 'maya', cushion_rate: 1.5 }), '400 BAD_REQUEST');
  assert.equal(code({ user_id: 'maya', cushion_rate: -0.1 }), '400 BAD_REQUEST');
  assert.equal(code({ user_id: 'maya', buffer_target: -1 }), '400 BAD_REQUEST');
  assert.equal(code({ user_id: 'maya', status: 'sleeping' }), '400 BAD_REQUEST');
  assert.equal(code({ user_id: 'maya', absorb_overspend: 'yes' }), '400 BAD_REQUEST');
  assert.equal(code({ user_id: 'maya', budgets: {} }), '400 BAD_REQUEST');
  assert.equal(code({ user_id: 'maya', budgets: [{ category_key: 'yachts', weekly_amount: 5 }] }), '400 BAD_REQUEST');
  assert.equal(code({ user_id: 'maya', budgets: [{ category_key: 'groceries', weekly_amount: -5 }] }), '400 BAD_REQUEST');
  assert.equal(code({ user_id: 'maya', budgets: [{ category_key: 'groceries', weekly_amount: 'lots' }] }), '400 BAD_REQUEST');
  assert.equal(code({ user_id: 'maya', cushion_rate: 0, buffer_target: 0 }), 'ok');
});

// ---------- digest ----------

const digestInput = (over = {}) => ({
  userId: 'maya', users: [userRow()], audits: auditRows, orders: orderRows('portfolio'), config: configRows,
  prices: pricesFromAlpaca(pricesOf('portfolio')), clock: { market_open: false, next_open: null }, fx: { rates: { CAD: 1.3826 } }, asOf: AS_OF, ...over,
});

test('digestFacts picks the latest audit, or the given one; 404 when there is none', () => {
  const { facts } = digestFacts(digestInput());
  assert.equal(facts.audit_id, 'maya-2026-11-02');
  assert.equal(facts.invested_cad, 26.15);
  assert.equal(facts.best_category.label, 'Other variable');
  assert.equal(facts.lifetime_invested_cad, 98.58);
  assert.equal(facts.portfolio.market_value_cad, 99.52);
  assert.equal(facts.fv_30y_at_6_cad, 150.19);
  assert.equal(facts.sent_to, 'maya@example.com');
  assert.equal(digestFacts(digestInput({ auditId: 'maya-2026-10-19' })).facts.invested_cad, 45.18);
  assert.equal(digestFacts(digestInput({ auditId: 'maya-1999-01-04' })).error.status, 404);
  assert.equal(digestFacts(digestInput({ audits: [{}] })).error.status, 404);
  assert.equal(digestFacts(digestInput({ userId: 'ghost' })).error.status, 404);
  const demo = digestFacts(digestInput({ config: [...configRows.filter((r) => r.key !== 'demo_email_to'), { key: 'demo_email_to', value: 'judge@example.org' }] }));
  assert.equal(demo.facts.sent_to, 'judge@example.org');
});

const variant = (over) => {
  const row = { ...auditRows.at(-1), ...over };
  return digestFacts(digestInput({ audits: [row] })).facts;
};

test('template fallback: 80-120 words, mentions the best category, labels the projection illustrative', () => {
  const cases = {
    invested: digestFacts(digestInput()).facts,
    carried: variant({ status: 'carried', investable_cad: 0, pending_carry_after: 3.2 }),
    computed: variant({ status: 'computed' }),
    paused: variant({ status: 'skipped_paused', lines_json: '[]', gross_surplus: 0, total_over: 0, to_buffer: 0, investable_cad: 0 }),
    noOverNoBest: variant({ lines_json: JSON.stringify([{ category_key: 'groceries', label: 'Groceries', planned: 80, actual: 80, under: 0, over: 0 }]), gross_surplus: 0, total_over: 0 }),
  };
  for (const [name, f] of Object.entries(cases)) {
    const t = digestTemplate(f);
    const n = wordCount(t);
    assert.ok(n >= 80 && n <= 120, `${name}: ${n} words: ${t}`);
    assert.doesNotMatch(t, /\b(buy|sell|VTI|VXUS|BND|EWC|SGOV)\b/i, name);
    if (f.best_category) assert.match(t, new RegExp(f.best_category.label), name);
    if (/years/.test(t)) assert.match(t, /Illustrative, not a prediction/, name);
  }
  assert.match(digestTemplate(cases.invested), /\$26\.15 could grow to about \$150\.19 in 30 years/);
  assert.match(digestTemplate(cases.carried), /\$3\.20 is below the \$5\.00 minimum/);
});

test('checkDigestText rejects advice, tickers, unlabelled projections, wrong length, missing best category', () => {
  const f = digestFacts(digestInput()).facts;
  const good = digestTemplate(f);
  assert.equal(checkDigestText(good, f).ok, true);
  assert.equal(checkDigestText('', f).ok, false);
  assert.equal(checkDigestText('Too short.', f).ok, false);
  assert.equal(checkDigestText(`${good} You should buy more VTI.`, f).ok, false);
  assert.equal(checkDigestText(good.replace('Illustrative, not a prediction: at', 'At'), f).ok, false);
  assert.equal(checkDigestText(good.replaceAll('Other variable', 'Something'), f).ok, false);
  assert.equal(checkDigestText(`**Bold** ${good}`, f).ok, false);
  assert.equal(digestSummary(f, null).source, 'template');
  assert.equal(digestSummary(f, good).source, 'llm');
});

test('digestPrompt carries the rules and the facts', () => {
  const f = digestFacts(digestInput()).facts;
  const p = digestPrompt(f);
  assert.match(p.system, /80 to 120 words/);
  assert.match(p.system, /illustrative, not a prediction/);
  assert.match(p.system, /best category/);
  assert.match(p.user, /Other variable, \$20\.00 under plan/);
  assert.match(p.user, /\$150\.19 at 6% a year/);
});

test('digestEmail: subject per status, scoreboard, FV lines, footer', () => {
  const f = digestFacts(digestInput()).facts;
  const e = digestEmail(f, digestTemplate(f));
  assert.equal(e.subject, 'Your week: $26.15 invested');
  assert.match(e.body, /Scoreboard, Nov 2 to Nov 8/);
  assert.match(e.body, /Shopping\s+\$52\.40 of \$40\.00\s+over \$12\.40/);
  assert.match(e.body, /6%: \$46\.83 in 10 years, \$83\.87 in 20 years, \$150\.19 in 30 years/);
  assert.match(e.body, /Lifetime invested: \$98\.58 CAD/);
  assert.ok(e.body.endsWith(LO_FOOTER));
  assert.equal(digestEmail(variant({ status: 'carried', investable_cad: 0, pending_carry_after: 3.2 }), 'x').subject, 'Your week: $3.20 carried to next week');
  assert.equal(digestEmail(variant({ status: 'skipped_paused' }), 'x').subject, 'Your week: investing is paused');
  assert.equal(money(1234.5), '$1,234.50');
});
