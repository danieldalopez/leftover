import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as A from './allocate.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const SYMBOLS = { equity_us: 'VTI', equity_intl: 'VXUS', equity_ca: 'EWC', bonds: 'BND', cash: 'SGOV' };
const BALANCED = { equity_us: 0.36, equity_intl: 0.21, equity_ca: 0.03, bonds: 0.4, cash: 0 };
const CONFIG = {
  fx_fallback_usdcad: '1.38',
  alpaca_base_url: 'https://paper-api.alpaca.markets',
  sleeve_symbols: JSON.stringify(SYMBOLS),
};
const USER = {
  user_id: 'test-b', status: 'active', consent_at: '2026-10-01T00:00:00.000Z',
  min_invest: 5, max_weekly_invest: 200, pending_carry: 0,
};
const PROFILE = { user_id: 'test-b', tier: 'balanced', home_bias: 'global', allocation_json: JSON.stringify(BALANCED) };
const AUDIT = { audit_id: 'test-b-2026-11-09', user_id: 'test-b', status: 'computed', investable_cad: 26.15 };
const FX = { amount: 1, base: 'USD', date: '2026-11-13', rates: { CAD: 1.381 } };
const REQ = { audit_id: 'test-b-2026-11-09', user_id: 'test-b', investable_cad: 26.15 };

const http = (statusCode, body) => ({ statusCode, statusMessage: '', headers: {}, body });
const alpacaOrder = (o) => ({
  id: `id-${o.client_order_id}`, client_order_id: o.client_order_id, symbol: o.symbol, status: 'accepted',
  notional: String(o.notional_usd), filled_qty: '0', filled_avg_price: null,
  submitted_at: '2026-11-15T04:00:09.123456Z', created_at: '2026-11-15T04:00:09.1Z', filled_at: null, ...o.extra,
});
const sumCents = (xs) => xs.reduce((a, x) => a + A.toCents(x), 0);

// ---------- money ----------

test('toCents strips float noise', () => {
  assert.equal(A.toCents(26.15), 2615);
  assert.equal(A.toCents(1.005), 101);
  assert.equal(A.toCents('9.41'), 941);
  assert.equal(A.round2(0.1 + 0.2), 0.3);
  assert.throws(() => A.toCents('abc'));
});

test('splitCents preserves the total and follows largest remainder', () => {
  assert.deepEqual(A.splitCents(2615, [0.36, 0.21, 0.03, 0.4]), [941, 549, 79, 1046]);
  assert.deepEqual(A.splitCents(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(A.splitCents(0, [1, 2]), [0, 0]);
  assert.throws(() => A.splitCents(10, [0, 0]));
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 500; k += 1) {
    const total = Math.floor(rnd() * 100000);
    const ws = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => rnd());
    const out = A.splitCents(total, ws);
    assert.equal(out.reduce((a, b) => a + b, 0), total);
    const sum = ws.reduce((a, b) => a + b, 0);
    out.forEach((c, i) => assert.ok(Math.abs(c - (total * ws[i]) / sum) < 1 + 1e-9));
  }
});

// ---------- weights ----------

test('sleeveWeights follows spec §11.5 for every tier and home bias', () => {
  assert.deepEqual(A.sleeveWeights('balanced', 'global'), BALANCED);
  assert.deepEqual(A.sleeveWeights('growth', 'more_canada'), { equity_us: 0.36, equity_intl: 0.2, equity_ca: 0.24, bonds: 0.2, cash: 0 });
  assert.deepEqual(A.sleeveWeights('cash'), { equity_us: 0, equity_intl: 0, equity_ca: 0, bonds: 0, cash: 1 });
  assert.deepEqual(A.sleeveWeights('conservative', 'global'), { equity_us: 0.12, equity_intl: 0.07, equity_ca: 0.01, bonds: 0.6, cash: 0.2 });
  for (const tier of Object.keys(A.TIER_MIX)) {
    for (const bias of ['global', 'more_canada']) {
      const w = A.sleeveWeights(tier, bias);
      assert.ok(Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9, `${tier}/${bias}`);
    }
  }
  assert.deepEqual(A.sleeveWeights('balanced', 'no_preference'), BALANCED, 'unknown bias = global market weight');
  assert.throws(() => A.sleeveWeights('yolo'), /unknown tier/);
});

test('the seed profile allocation equals the balanced/global weights', () => {
  const seed = readJson('demo/seed-data.json');
  assert.deepEqual(A.parseWeights(JSON.stringify(seed.profile.allocation)), A.sleeveWeights(seed.profile.tier, seed.profile.home_bias));
});

test('parseWeights validates allocation_json', () => {
  assert.deepEqual(A.parseWeights('{"bonds":0.5,"cash":0.5}'), { equity_us: 0, equity_intl: 0, equity_ca: 0, bonds: 0.5, cash: 0.5 });
  assert.throws(() => A.parseWeights('{oops'), /not valid JSON/);
  assert.throws(() => A.parseWeights('[]'), /object/);
  assert.throws(() => A.parseWeights({ crypto: 1 }), /unknown sleeve/);
  assert.throws(() => A.parseWeights({ bonds: -0.1, cash: 1.1 }), />= 0/);
  assert.throws(() => A.parseWeights({ bonds: 60, cash: 40 }), /sum to 100/);
  assert.doesNotThrow(() => A.parseWeights({ bonds: 0.333, equity_us: 0.333, cash: 0.333 }), 'rounding slack of 1%');
});

test('resolveWeights: edited allocation wins, tier only when none, broken allocation is an error', () => {
  assert.equal(A.resolveWeights(PROFILE).source, 'profile');
  const tierOnly = A.resolveWeights({ tier: 'growth', home_bias: 'global', allocation_json: '' });
  assert.equal(tierOnly.source, 'tier');
  assert.equal(tierOnly.weights.bonds, 0.2);
  assert.throws(() => A.resolveWeights({ tier: 'growth', allocation_json: '{"bonds":2}' }), /sum/);
});

// ---------- FX ----------

test('pickFxRate: Frankfurter, then the config fallback', () => {
  assert.deepEqual(A.pickFxRate(FX, '1.38'), { fx_rate: 1.381, fx_source: 'frankfurter', fx_date: '2026-11-13' });
  assert.equal(A.pickFxRate({ rates: { CAD: 1.425812 } }, '1.38').fx_rate, 1.4258);
  assert.deepEqual(A.pickFxRate({ error: 'ECONNRESET' }, '1.38'), { fx_rate: 1.38, fx_source: 'fallback', fx_date: null });
  assert.equal(A.pickFxRate(null, '1.38').fx_source, 'fallback');
  assert.equal(A.pickFxRate({ base: 'EUR', rates: { CAD: 1.5 } }, '1.38').fx_source, 'fallback', 'wrong base');
  assert.equal(A.pickFxRate({ base: 'USD', rates: { CAD: 138 } }, '1.38').fx_source, 'fallback', 'absurd rate');
  assert.throws(() => A.pickFxRate(null, ''), /no usable/);
  assert.throws(() => A.pickFxRate(null, 'abc'), /no usable/);
});

// ---------- the split ----------

test('allocate reproduces every order in contracts/fixtures/portfolio.json to the cent', () => {
  const { orders } = readJson('contracts/fixtures/portfolio.json').data;
  const byAudit = {};
  for (const o of orders) (byAudit[o.audit_id] ||= []).push(o);
  assert.equal(Object.keys(byAudit).length, 3);
  for (const [auditId, expected] of Object.entries(byAudit)) {
    const investable = sumCents(expected.map((o) => o.notional_cad)) / 100;
    const r = A.allocate({ investable_cad: investable, weights: BALANCED, fx_rate: expected[0].fx_rate, symbols: SYMBOLS, audit_id: auditId });
    assert.deepEqual(
      r.orders.map((o) => [o.client_order_id, o.symbol, o.sleeve, o.notional_cad, o.notional_usd]),
      expected.map((o) => [o.client_order_id, o.symbol, o.sleeve, o.notional_cad, o.notional_usd]),
      auditId,
    );
    assert.equal(r.folded.length, 1, 'EWC (3%) is under $1 USD and folds into BND');
    assert.deepEqual([r.folded[0].symbol, r.folded[0].into], ['EWC', 'bonds']);
  }
});

test('allocate matches the LO-05 example in contracts/webhooks.md', () => {
  const r = A.allocate({ investable_cad: 26.15, weights: BALANCED, fx_rate: 1.381, symbols: SYMBOLS, audit_id: 'maya-2026-11-02' });
  assert.equal(r.invested_cad, 26.15);
  assert.equal(r.invested_usd, 18.94);
  assert.deepEqual(r.orders.map((o) => o.client_order_id), ['maya-2026-11-02-VTI', 'maya-2026-11-02-VXUS', 'maya-2026-11-02-BND']);
});

test('the minimum is applied in USD: CAD 1.36 is above $1 CAD but below $1 USD', () => {
  const r = A.allocate({ investable_cad: 45.18, weights: BALANCED, fx_rate: 1.3795, symbols: SYMBOLS, audit_id: 'a-2026-10-19' });
  assert.equal(r.folded[0].notional_cad, 1.36);
  assert.equal(r.orders.find((o) => o.symbol === 'BND').notional_cad, 19.43);
});

test('allocate: totals preserved, every order clears the minimum (fuzz)', () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const tiers = Object.keys(A.TIER_MIX);
  for (let k = 0; k < 2000; k += 1) {
    const investable = 5 + Math.floor(rnd() * 19500) / 100; // 5.00 … 199.99
    const fx = 1.2 + Math.floor(rnd() * 4000) / 10000;
    const weights = A.sleeveWeights(tiers[k % tiers.length], rnd() < 0.5 ? 'global' : 'more_canada');
    const r = A.allocate({ investable_cad: investable, weights, fx_rate: fx, symbols: SYMBOLS, audit_id: 'test-b-2026-11-09' });
    assert.equal(sumCents(r.orders.map((o) => o.notional_cad)), A.toCents(investable));
    assert.equal(sumCents(r.orders.map((o) => o.notional_usd)), Math.round(Number(((A.toCents(investable)) / fx).toFixed(6))));
    for (const o of r.orders) assert.ok(o.notional_usd >= 1, `${investable} @ ${fx}: ${o.symbol} ${o.notional_usd}`);
    assert.equal(new Set(r.orders.map((o) => o.client_order_id)).size, r.orders.length);
  }
});

test('allocate: edge cases', () => {
  const cash = A.allocate({ investable_cad: 5, weights: A.sleeveWeights('cash'), fx_rate: 1.4, symbols: SYMBOLS, audit_id: 'u-2026-11-09' });
  assert.deepEqual(cash.orders.map((o) => [o.symbol, o.notional_cad, o.notional_usd]), [['SGOV', 5, 3.57]]);
  // everything small folds into the largest sleeve
  const tiny = A.allocate({ investable_cad: 2.5, weights: BALANCED, fx_rate: 1.4, symbols: SYMBOLS, audit_id: 'u-2026-11-09' });
  assert.deepEqual(tiny.orders.map((o) => o.symbol), ['BND']);
  assert.equal(tiny.orders[0].notional_cad, 2.5);
  assert.throws(() => A.allocate({ investable_cad: 1.2, weights: BALANCED, fx_rate: 1.4, symbols: SYMBOLS, audit_id: 'u-1' }), /below Alpaca's minimum/);
  assert.throws(() => A.allocate({ investable_cad: 0, weights: BALANCED, fx_rate: 1.4, symbols: SYMBOLS, audit_id: 'u-1' }), /greater than 0/);
  assert.throws(() => A.allocate({ investable_cad: 10, weights: BALANCED, fx_rate: 0, symbols: SYMBOLS, audit_id: 'u-1' }), /fx_rate/);
  assert.throws(() => A.allocate({ investable_cad: 10, weights: BALANCED, fx_rate: 1.4, symbols: { ...SYMBOLS, bonds: '' }, audit_id: 'u-1' }), /no ticker for sleeve bonds/);
  assert.throws(() => A.allocate({ investable_cad: 10, weights: BALANCED, fx_rate: 1.4, symbols: { ...SYMBOLS, bonds: 'VTI' }, audit_id: 'u-1' }), /two sleeves/);
});

test('client_order_id = {audit_id}-{symbol}, short enough for the -r1 retry', () => {
  assert.equal(A.clientOrderId('maya-2026-11-02', 'VTI'), 'maya-2026-11-02-VTI');
  assert.throws(() => A.clientOrderId(`${'x'.repeat(40)}-2026-11-02`, 'VXUS'), /too long/);
  assert.ok(A.isRetryId('maya-2026-11-02-VTI-r1'));
  assert.ok(!A.isRetryId('maya-2026-11-02-VTI'));
});

// ---------- statuses and HTTP ----------

test('apiOrderStatus maps raw Alpaca statuses per spec §19.2', () => {
  const cases = { filled: 'filled', partially_filled: 'partially_filled', rejected: 'rejected', canceled: 'canceled', expired: 'canceled', new: 'queued', accepted: 'queued', pending_new: 'queued', done_for_day: 'queued' };
  for (const [raw, api] of Object.entries(cases)) assert.equal(A.apiOrderStatus(raw), api, raw);
  assert.ok(A.isTerminalStatus('filled') && A.isTerminalStatus('expired') && !A.isTerminalStatus('accepted') && !A.isTerminalStatus('done_for_day') && !A.isTerminalStatus(''));
});

test('readHttp normalizes n8n HTTP Request items', () => {
  assert.deepEqual(A.readHttp(http(200, { id: 'x' })), { ok: true, status: 200, body: { id: 'x' }, error: null });
  assert.equal(A.readHttp(http(422, { code: 40010001, message: 'client_order_id must be unique' })).error, 'HTTP 422: client_order_id must be unique');
  assert.deepEqual(A.readHttp({ error: { message: 'Credentials not found' } }), { ok: false, status: 0, body: null, error: 'Credentials not found' });
  assert.equal(A.readHttp({ error: 'getaddrinfo ENOTFOUND' }).error, 'getaddrinfo ENOTFOUND');
  assert.equal(A.readHttp(undefined).ok, false);
});

test('accountReady: missing credential, bad keys, blocked account, OK', () => {
  assert.match(A.accountReady({ error: 'Credential with ID "x" does not exist' }).reason, /credential is missing/);
  assert.match(A.accountReady(http(401, { message: 'unauthorized.' })).reason, /refused the API keys/);
  assert.match(A.accountReady(http(500, 'oops')).reason, /check failed/);
  assert.match(A.accountReady(http(200, { status: 'ACTIVE', trading_blocked: true })).reason, /blocked/);
  assert.match(A.accountReady(http(200, { status: 'ONBOARDING' })).reason, /ONBOARDING/);
  assert.deepEqual(A.accountReady(http(200, { status: 'ACTIVE', trading_blocked: false, account_blocked: false })), { ready: true, reason: null });
});

test('isoOrNull trims Alpaca nanoseconds to plain ISO', () => {
  assert.equal(A.isoOrNull('2026-11-15T04:00:09.123456789Z'), '2026-11-15T04:00:09.123Z');
  assert.equal(A.isoOrNull('2026-11-15T04:00:09Z'), '2026-11-15T04:00:09.000Z');
  assert.equal(A.isoOrNull('2026-11-15T04:00:09.5-05:00'), '2026-11-15T09:00:09.500Z');
  assert.equal(A.isoOrNull(null), null);
  assert.equal(A.isoOrNull('garbage'), null);
});

test('placementResult: placed, duplicate, refused', () => {
  const planned = { client_order_id: 'test-b-2026-11-09-VTI', symbol: 'VTI', sleeve: 'equity_us', notional_cad: 9.41, notional_usd: 6.81 };
  const order = alpacaOrder(planned);
  const ok = A.placementResult(planned, http(200, order), http(200, order));
  assert.equal(ok.placed, true);
  assert.equal(ok.duplicate, false);
  assert.equal(ok.alpaca_order_id, 'id-test-b-2026-11-09-VTI');
  assert.equal(ok.status, 'accepted');
  assert.equal(ok.filled_avg_price, 0);
  const dup = A.placementResult(planned, http(422, { code: 40010001, message: 'client_order_id must be unique' }), http(200, { ...order, status: 'filled', filled_qty: '0.02' }));
  assert.equal(dup.placed, true);
  assert.equal(dup.duplicate, true);
  assert.equal(dup.filled_qty, 0.02);
  const lookupDown = A.placementResult(planned, http(200, order), { error: 'timeout' });
  assert.equal(lookupDown.placed, true);
  const refused = A.placementResult(planned, http(403, { message: 'insufficient buying power' }), http(404, { message: 'order not found' }));
  assert.equal(refused.placed, false);
  assert.equal(refused.error, 'HTTP 403: insufficient buying power');
  const other = A.placementResult(planned, http(500, ''), http(200, { ...order, client_order_id: 'someone-else' }));
  assert.equal(other.placed, false);
});

// ---------- LO-05 ----------

const plan = (over = {}) => A.planInvest({ request: REQ, user: USER, profile: PROFILE, audit: AUDIT, config: CONFIG, existingOrders: [], fxBody: FX, ...over });

test('planInvest: dry run returns the would-be orders and touches nothing', () => {
  const r = plan({ request: { ...REQ, dry_run: true } });
  assert.equal(r.proceed, false);
  assert.equal(r.http_status, 200);
  assert.equal(r.envelope.ok, true);
  const d = r.envelope.data;
  assert.equal(d.status, 'dry_run');
  assert.equal(d.fx_source, 'frankfurter');
  assert.equal(d.fx_rate, 1.381);
  assert.equal(d.invested_usd, 18.94);
  assert.deepEqual(d.orders.map((o) => [o.symbol, o.notional_cad, o.notional_usd, o.status, o.duplicate]), [
    ['VTI', 9.41, 6.81, 'dry_run', false], ['VXUS', 5.49, 3.98, 'dry_run', false], ['BND', 11.25, 8.15, 'dry_run', false],
  ]);
  assert.equal(plan({ request: { ...REQ, dry_run: 'true' } }).envelope.data.status, 'dry_run');
});

test('planInvest: dry run needs no audit, uses the fallback rate when Frankfurter fails', () => {
  const r = plan({ request: { ...REQ, dry_run: true }, audit: null, fxBody: { error: 'down' } });
  assert.equal(r.envelope.data.fx_source, 'fallback');
  assert.equal(r.envelope.data.fx_rate, 1.38);
});

test('planInvest: live run proceeds with a plan', () => {
  const r = plan();
  assert.equal(r.proceed, true);
  assert.equal(r.plan.alpaca_base_url, 'https://paper-api.alpaca.markets');
  assert.equal(r.plan.orders.length, 3);
  assert.equal(r.plan.orders[0].status, undefined);
});

test('planInvest: request validation', () => {
  const code = (over) => { const r = plan(over); return [r.http_status, r.envelope.error && r.envelope.error.code]; };
  assert.deepEqual(code({ request: { ...REQ, user_id: '' } }), [400, 'BAD_REQUEST']);
  assert.deepEqual(code({ request: { ...REQ, audit_id: '' } }), [400, 'BAD_REQUEST']);
  assert.deepEqual(code({ request: { ...REQ, audit_id: 'maya-2026-11-09' } }), [400, 'BAD_REQUEST']);
  assert.deepEqual(code({ request: { ...REQ, investable_cad: 'lots' } }), [400, 'BAD_REQUEST']);
  assert.deepEqual(code({ request: { ...REQ, investable_cad: -3 } }), [400, 'BAD_REQUEST']);
  assert.deepEqual(code({ request: { ...REQ, investable_cad: 250 } }), [400, 'BAD_REQUEST'], 'above max_weekly_invest');
  assert.deepEqual(code({ request: { ...REQ, investable_cad: 4.99 } }), [400, 'BAD_REQUEST'], 'below min_invest');
  assert.deepEqual(code({ user: null }), [404, 'NOT_FOUND']);
  assert.deepEqual(code({ profile: null }), [404, 'NOT_FOUND']);
  assert.deepEqual(code({ audit: null }), [404, 'NOT_FOUND']);
  assert.deepEqual(code({ audit: { ...AUDIT, user_id: 'test-a' } }), [400, 'BAD_REQUEST']);
  assert.deepEqual(code({ audit: { ...AUDIT, status: 'carried' } }), [400, 'BAD_REQUEST']);
  assert.deepEqual(code({ user: { ...USER, status: 'paused' } }), [400, 'BAD_REQUEST']);
  assert.deepEqual(code({ user: { ...USER, consent_at: null } }), [400, 'BAD_REQUEST']);
  assert.deepEqual(code({ profile: { ...PROFILE, allocation_json: '{"bonds":3}' } }), [400, 'BAD_REQUEST']);
  assert.deepEqual(code({ config: { ...CONFIG, alpaca_base_url: 'https://api.alpaca.markets' } }), [500, 'INTERNAL'], 'never live');
  assert.deepEqual(code({ config: { ...CONFIG, sleeve_symbols: '' } }), [500, 'INTERNAL']);
  assert.deepEqual(code({ fxBody: null, config: { ...CONFIG, fx_fallback_usdcad: '' } }), [502, 'UPSTREAM_ERROR']);
  assert.deepEqual(code({ request: { ...REQ, investable_cad: 5, dry_run: true }, profile: { ...PROFILE, allocation_json: '{"bonds":1}' }, fxBody: { rates: { CAD: 1.9 } } }), [200, undefined]);
});

test('planInvest: an invested audit returns its orders and places nothing (idempotent)', () => {
  const rows = [
    { client_order_id: 'test-b-2026-11-09-VTI', audit_id: 'test-b-2026-11-09', symbol: 'VTI', sleeve: 'equity_us', notional_cad: 9.41, notional_usd: 6.81, fx_rate: 1.381, status: 'filled' },
    { client_order_id: 'test-b-2026-11-09-BND', audit_id: 'test-b-2026-11-09', symbol: 'BND', sleeve: 'bonds', notional_cad: 16.74, notional_usd: 12.13, fx_rate: 1.381, status: 'accepted' },
  ];
  const r = plan({ audit: { ...AUDIT, status: 'invested' }, existingOrders: rows });
  assert.equal(r.proceed, false);
  assert.equal(r.envelope.data.status, 'invested');
  assert.equal(r.envelope.data.already_invested, true);
  assert.equal(r.envelope.data.invested_cad, 26.15);
  assert.deepEqual(r.envelope.data.orders.map((o) => [o.status, o.duplicate]), [['filled', true], ['queued', true]]);
});

test('planInvest: a re-run after a partial failure reuses the earlier FX rate', () => {
  const rows = [{ client_order_id: 'test-b-2026-11-09-VTI', audit_id: 'test-b-2026-11-09', fx_rate: 1.3795, status: 'accepted' }];
  const r = plan({ existingOrders: rows, fxBody: { rates: { CAD: 1.45 } } });
  assert.equal(r.plan.fx_rate, 1.3795);
  assert.equal(r.plan.fx_source, 'previous_run');
});

test('planInvest: warns when the amount differs from the audit', () => {
  assert.deepEqual(plan({ audit: { ...AUDIT, investable_cad: 20 } }).plan.warnings, ["investable_cad 26.15 differs from the audit's 20"]);
  assert.equal(plan().plan.warnings, undefined);
});

test('upstreamResult: Alpaca missing behaves like dry_run with UPSTREAM_ERROR', () => {
  const p = plan().plan;
  const r = A.upstreamResult(p, 'Alpaca not reachable or the "Alpaca Paper" credential is missing (x)');
  assert.equal(r.http_status, 502);
  assert.equal(r.envelope.ok, false);
  assert.equal(r.envelope.error.code, 'UPSTREAM_ERROR');
  assert.equal(r.envelope.data.status, 'dry_run');
  assert.ok(r.envelope.data.orders.every((o) => o.status === 'dry_run'));
  assert.equal(r.envelope.data.alpaca_base_url, undefined);
  assert.equal(r.envelope.data.pending_carry, undefined);
});

test('finishInvest: all placed -> invested, rows, pending_carry reduced', () => {
  const p = plan({ user: { ...USER, pending_carry: 30 } }).plan;
  const results = p.orders.map((o) => A.placementResult(o, http(200, alpacaOrder(o)), http(200, alpacaOrder(o))));
  const r = A.finishInvest(p, results);
  assert.equal(r.all_placed, true);
  assert.equal(r.http_status, 200);
  assert.equal(r.envelope.data.status, 'invested');
  assert.equal(r.envelope.data.invested_cad, 26.15);
  assert.deepEqual(r.envelope.data.orders.map((o) => [o.status, o.alpaca_status]), [['queued', 'accepted'], ['queued', 'accepted'], ['queued', 'accepted']]);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(Object.keys(r.rows[0]).sort(), ['alpaca_order_id', 'audit_id', 'client_order_id', 'filled_at', 'filled_avg_price', 'filled_qty', 'fx_rate', 'notional_cad', 'notional_usd', 'sleeve', 'status', 'submitted_at', 'symbol', 'user_id']);
  assert.equal(r.rows[0].fx_rate, 1.381);
  assert.equal(r.pending_carry_after, 3.85);
  assert.equal(A.finishInvest(plan().plan, results).pending_carry_after, 0, 'never negative');
});

test('finishInvest: one refused -> partial, UPSTREAM_ERROR, only placed rows written', () => {
  const p = plan().plan;
  const results = p.orders.map((o, i) => (i === 1
    ? A.placementResult(o, http(422, { message: 'asset VXUS is not fractionable' }), http(404, { message: 'order not found' }))
    : A.placementResult(o, http(200, alpacaOrder(o)), http(200, alpacaOrder(o)))));
  const r = A.finishInvest(p, results);
  assert.equal(r.all_placed, false);
  assert.equal(r.http_status, 502);
  assert.equal(r.envelope.error.code, 'UPSTREAM_ERROR');
  assert.match(r.envelope.error.message, /VXUS: HTTP 422: asset VXUS is not fractionable/);
  assert.equal(r.envelope.data.status, 'partial');
  assert.equal(r.envelope.data.invested_cad, 20.66);
  assert.equal(r.envelope.data.orders[1].status, 'failed');
  assert.equal(r.rows.length, 2);
  assert.equal(r.pending_carry_after, null);
});

test('internalResult: the data object for LO-04, with error when not invested', () => {
  const ok = A.envelopeOk({ status: 'invested' });
  assert.deepEqual(A.internalResult(ok, REQ), { status: 'invested' });
  const up = A.envelopeError('UPSTREAM_ERROR', 'down', { status: 'dry_run' });
  assert.deepEqual(A.internalResult(up, REQ), { status: 'dry_run', error: { code: 'UPSTREAM_ERROR', message: 'down' } });
  const bad = A.envelopeError('NOT_FOUND', 'unknown user');
  assert.deepEqual(A.internalResult(bad, REQ), { audit_id: REQ.audit_id, user_id: 'test-b', status: 'failed', error: { code: 'NOT_FOUND', message: 'unknown user' } });
});

test('configMap turns config rows into an object', () => {
  assert.deepEqual(A.configMap([{ key: 'a', value: '1' }, { key: 'b', value: 'x' }, {}]), { a: '1', b: 'x' });
});

// ---------- LO-06 ----------

const ROW = {
  client_order_id: 'test-b-2026-11-09-VTI', audit_id: 'test-b-2026-11-09', user_id: 'test-b', symbol: 'VTI', sleeve: 'equity_us',
  notional_usd: 6.81, notional_cad: 9.41, fx_rate: 1.381, alpaca_order_id: 'id-1', status: 'accepted',
  filled_qty: 0, filled_avg_price: 0, submitted_at: '2026-11-15T04:00:09.000Z', filled_at: null,
};
const lookup = (extra) => http(200, { id: 'id-1', client_order_id: ROW.client_order_id, symbol: 'VTI', status: 'accepted', filled_qty: '0', filled_avg_price: null, submitted_at: '2026-11-15T04:00:09.123456Z', filled_at: null, ...extra });

test('pickOpenOrders skips terminal orders and filters by user', () => {
  const rows = [ROW, { ...ROW, client_order_id: 'b', status: 'filled' }, { ...ROW, client_order_id: 'c', user_id: 'test-e' }, { ...ROW, client_order_id: 'd', status: '' }];
  assert.deepEqual(A.pickOpenOrders(rows).map((r) => r.client_order_id), [ROW.client_order_id, 'c', 'd']);
  assert.deepEqual(A.pickOpenOrders(rows, 'test-b').map((r) => r.client_order_id), [ROW.client_order_id, 'd']);
});

test('reconcileOrder: unchanged, filled, missing, error', () => {
  assert.equal(A.reconcileOrder(ROW, lookup(), new Set()).kind, 'unchanged', 'microseconds on submitted_at are not a change');
  const filled = A.reconcileOrder(ROW, lookup({ status: 'filled', filled_qty: '0.020261827', filled_avg_price: '336.1', filled_at: '2026-11-16T14:30:02.1Z' }), new Set());
  assert.equal(filled.kind, 'updated');
  assert.deepEqual(filled.patch, { status: 'filled', filled_qty: 0.020261827, filled_avg_price: 336.1, filled_at: '2026-11-16T14:30:02.100Z' });
  assert.equal(filled.retry, null);
  assert.equal(A.reconcileOrder(ROW, http(404, { message: 'order not found' }), new Set()).kind, 'missing');
  assert.equal(A.reconcileOrder(ROW, { error: 'credential missing' }, new Set()).kind, 'error');
});

test('reconcileOrder: rejected -> one -r1 retry, rejected retry -> alert', () => {
  const rej = A.reconcileOrder(ROW, lookup({ status: 'rejected' }), new Set([ROW.client_order_id]));
  assert.equal(rej.patch.status, 'rejected');
  assert.deepEqual(rej.retry, { client_order_id: 'test-b-2026-11-09-VTI-r1', audit_id: ROW.audit_id, user_id: 'test-b', symbol: 'VTI', sleeve: 'equity_us', notional_usd: 6.81, notional_cad: 9.41, fx_rate: 1.381 });
  assert.equal(rej.alert, null);
  assert.equal(A.reconcileOrder(ROW, lookup({ status: 'rejected' }), new Set(['test-b-2026-11-09-VTI-r1'])).retry, null, 'retry exists already');
  const r1 = { ...ROW, client_order_id: 'test-b-2026-11-09-VTI-r1' };
  const again = A.reconcileOrder(r1, http(200, { ...lookup().body, client_order_id: r1.client_order_id, status: 'rejected' }), new Set());
  assert.equal(again.retry, null);
  assert.match(again.alert, /rejected again/);
});

test('planReconcile + finishReconcile: counts, retries, alerts', () => {
  const open = [ROW, { ...ROW, client_order_id: 'test-b-2026-11-09-BND', symbol: 'BND' }, { ...ROW, client_order_id: 'test-e-2026-11-09-VTI', user_id: 'test-e' }];
  const s = A.planReconcile(open, [
    lookup({ status: 'filled', filled_qty: '0.02', filled_avg_price: '336.1', filled_at: '2026-11-16T14:30:02Z' }),
    http(200, { ...lookup().body, client_order_id: 'test-b-2026-11-09-BND', symbol: 'BND', status: 'rejected' }),
    http(404, { message: 'order not found' }),
  ], open);
  assert.equal(s.checked, 3);
  assert.equal(s.updates.length, 2);
  assert.deepEqual(s.retries.map((r) => r.client_order_id), ['test-b-2026-11-09-BND-r1']);
  assert.equal(s.problems.length, 1);
  const retry = s.retries[0];
  const placed = A.placementResult(retry, http(200, alpacaOrder(retry)), http(200, alpacaOrder(retry)));
  const f = A.finishReconcile(s, [{ ...retry, ...placed }]);
  assert.deepEqual(f.envelope.data, { checked: 3, updated: 2, retried: 1, failed: 1, problems: [{ client_order_id: 'test-e-2026-11-09-VTI', error: 'HTTP 404: order not found' }] });
  assert.equal(f.rows[0].client_order_id, 'test-b-2026-11-09-BND-r1');
  assert.equal(f.rows[0].fx_rate, 1.381);
  assert.deepEqual(f.alerts, []);
  const failedRetry = A.placementResult(retry, http(403, { message: 'nope' }), http(404, {}));
  const f2 = A.finishReconcile(s, [{ ...retry, ...failedRetry }]);
  assert.equal(f2.envelope.data.failed, 2);
  assert.match(f2.alerts[0], /could not be placed/);
});

// ---------- workflows embed this file verbatim ----------

test('LO-05 and LO-06 Code nodes embed lib/allocate.mjs verbatim', () => {
  const lib = readFileSync(join(root, 'lib/allocate.mjs'), 'utf8');
  const body = lib.slice(0, lib.indexOf('\nexport {')).trim();
  for (const file of ['n8n/workflows/05-invest-executor.json', 'n8n/workflows/06-order-reconcile.json']) {
    if (!existsSync(join(root, file))) continue;
    const wf = readJson(file);
    const embedding = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code' && n.parameters.jsCode.includes('// ---- lib/allocate.mjs ----'));
    assert.ok(embedding.length > 0, `${file} has Code nodes that embed lib/allocate.mjs`);
    for (const n of embedding) assert.ok(n.parameters.jsCode.includes(body), `${file} / ${n.name} is out of date: rebuild it`);
  }
});
