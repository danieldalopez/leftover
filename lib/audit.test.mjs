// Tests for lib/audit.mjs (spec §6, §10 WF04). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as week from './week.mjs';

// audit.mjs has no imports: in the Code node, lib/week.mjs is pasted above it.
// Reproduce that here by putting week.mjs on the global scope before loading it.
Object.assign(globalThis, week);
const A = await import('./audit.mjs');
const { seedDate, addDays } = week;

const seed = JSON.parse(readFileSync(new URL('../demo/seed-data.json', import.meta.url)));
const NOW = new Date('2026-11-14T23:30:00Z'); // Sat 2026-11-14 15:30 America/Vancouver
const THIS_MONDAY = '2026-11-09';

// ---------- fixtures ----------

function user(overrides = {}) {
  return {
    user_id: 'test-a', status: 'active', buffer_balance: 0, buffer_target: 100, cushion_rate: 0.5,
    absorb_overspend: true, min_invest: 5, max_weekly_invest: 200, pending_carry: 0, deficit_carry: 0,
    ...overrides,
  };
}

function budgets(pairs, userId = 'test-a') {
  return pairs.map(([category_key, weekly_amount], i) => ({
    id: i + 1, user_id: userId, category_key, label: category_key, weekly_amount, active: true,
  }));
}

let txnSeq = 0;
function txn(date, category_key, amount, extra = {}) {
  txnSeq += 1;
  return {
    txn_id: `t-${txnSeq}`, user_id: 'test-a', date, amount, category_key,
    pending: false, pending_txn_id: '', removed: false, ...extra,
  };
}

const B4 = budgets([['groceries', 80], ['eating_out', 50], ['transport', 30], ['entertainment', 40]]);

function audit(args) {
  return A.computeAudit({ prevAudit: null, nowIso: NOW.toISOString(), weekStartYmd: THIS_MONDAY, budgets: B4, ...args });
}

// In-memory tables + "what the workflow writes", so planAudits can be run week after week.
function tables({ users, budgetRows, transactions }) {
  return { users: users.map((u) => ({ ...u })), budgets: budgetRows, transactions, audits: [] };
}
function run(db, request, now = NOW) {
  const plan = A.planAudits({ request, users: db.users, budgets: db.budgets, transactions: db.transactions, audits: db.audits, now });
  if (!plan.ok) return plan;
  for (const item of plan.items) {
    if (!item.write) continue;
    db.audits = db.audits.filter((a) => a.audit_id !== item.audit.audit_id).concat([{ ...item.audit }]);
    if (item.user_update) {
      const u = db.users.find((x) => x.user_id === item.user_update.user_id);
      Object.assign(u, item.user_update);
    }
  }
  return plan;
}

// ---------- spec §6.8 worked example ----------

test('§6.8 worked example: $26 gross, buffer 60 → 39 → 52, investable $13', () => {
  const r = audit({
    user: user({ buffer_balance: 60 }),
    txns: [txn('2026-11-09', 'groceries', 62), txn('2026-11-10', 'eating_out', 71),
      txn('2026-11-11', 'transport', 22), txn('2026-11-12', 'entertainment', 40)],
  });
  assert.equal(r.audit.gross_surplus, 26);
  assert.equal(r.audit.total_over, 21);
  assert.equal(r.cents.afterAbsorbC, 3900);
  assert.equal(r.audit.to_buffer, 13);
  assert.equal(r.audit.buffer_after, 52);
  assert.equal(r.audit.late_adj, 0);
  assert.equal(r.audit.investable_cad, 13);
  assert.equal(r.audit.pending_carry_after, 0);
  assert.equal(r.audit.status, 'computed');
  assert.deepEqual(r.userUpdate, { user_id: 'test-a', buffer_balance: 52, pending_carry: 0, deficit_carry: 0 });
  assert.deepEqual(JSON.parse(r.audit.lines_json), [
    { category_key: 'groceries', label: 'groceries', planned: 80, actual: 62, under: 18, over: 0 },
    { category_key: 'eating_out', label: 'eating_out', planned: 50, actual: 71, under: 0, over: 21 },
    { category_key: 'transport', label: 'transport', planned: 30, actual: 22, under: 8, over: 0 },
    { category_key: 'entertainment', label: 'entertainment', planned: 40, actual: 40, under: 0, over: 0 },
  ]);
});

test('inline self-test passes and is the §6.8 example', () => {
  assert.equal(A.auditSelfTest(), true);
});

// ---------- §6.2 / §6.3 what counts ----------

test('refunds, pending → posted dedupe, removed and excluded rows, week bounds', () => {
  const txns = [
    txn('2026-11-09', 'groceries', 50),
    txn('2026-11-10', 'groceries', -12.5),                       // refund
    txn('2026-11-11', 'eating_out', 6.8, { txn_id: 'p1', pending: true }),
    txn('2026-11-12', 'eating_out', 6.8, { pending_txn_id: 'p1' }), // posted, replaces p1
    txn('2026-11-12', 'eating_out', 9, { pending: true }),          // still pending: counts
    txn('2026-11-12', 'eating_out', 14.25, { removed: true }),
    txn('2026-11-13', 'excluded', 1650),                           // rent
    txn('2026-11-13', 'shopping', 30),                             // not a budget of this user
    txn('2026-11-08', 'transport', 10),                            // Sunday before
    txn('2026-11-15', 'transport', 7),                             // Sunday: last day of the week
    txn('2026-11-16', 'transport', 99),                            // next Monday
  ];
  const spent = A.spendByCategory(txns, ['groceries', 'eating_out', 'transport', 'entertainment'], THIS_MONDAY);
  assert.deepEqual(spent, { groceries: 3750, eating_out: 1580, transport: 700, entertainment: 0 });
});

test('a posted row in the next week still supersedes its pending row', () => {
  const txns = [
    txn('2026-11-15', 'eating_out', 20, { txn_id: 'p2', pending: true }),
    txn('2026-11-16', 'eating_out', 22, { pending_txn_id: 'p2' }),
  ];
  assert.equal(A.spendByCategory(txns, ['eating_out'], THIS_MONDAY).eating_out, 0);
  assert.equal(A.spendByCategory(txns, ['eating_out'], '2026-11-16').eating_out, 2200);
});

test('a removed posted row does not hide its pending row', () => {
  const txns = [
    txn('2026-11-10', 'eating_out', 20, { txn_id: 'p3', pending: true }),
    txn('2026-11-11', 'eating_out', 20, { pending_txn_id: 'p3', removed: true }),
  ];
  assert.equal(A.spendByCategory(txns, ['eating_out'], THIS_MONDAY).eating_out, 2000);
});

test('booleans as stored by Data Tables (1/0) work', () => {
  const txns = [txn('2026-11-10', 'groceries', 20, { removed: 1 }), txn('2026-11-10', 'groceries', 5, { removed: 0 })];
  assert.equal(A.spendByCategory(txns, ['groceries'], THIS_MONDAY).groceries, 500);
  const rows = budgets([['groceries', 80], ['eating_out', 50]]).map((b, i) => ({ ...b, active: i === 0 ? 1 : 0 }));
  assert.deepEqual(A.activeBudgets(rows, 'test-a').map((b) => b.category_key), ['groceries']);
  assert.equal(A.userSettings(user({ absorb_overspend: 0 })).absorb, false);
});

test('refund bigger than the week\'s spend: negative actual, under capped at planned (spec §6.4)', () => {
  const r = audit({
    user: user({ buffer_balance: 100 }),
    budgets: budgets([['shopping', 40]]),
    txns: [txn('2026-11-10', 'shopping', 10), txn('2026-11-11', 'shopping', -35)],
  });
  const [line] = JSON.parse(r.audit.lines_json);
  assert.deepEqual(line, { category_key: 'shopping', label: 'shopping', planned: 40, actual: -25, under: 40, over: 0 });
  assert.equal(r.audit.gross_surplus, 40);
  assert.equal(r.audit.investable_cad, 40); // buffer already full: all of it is investable
});

// ---------- §6.4 no netting, §6.5 cushion ----------

test('categories are not netted: overspend only drains the cushion', () => {
  const r = audit({
    user: user({ buffer_balance: 100 }),
    txns: [txn('2026-11-10', 'groceries', 40), txn('2026-11-10', 'eating_out', 90)],
  });
  assert.equal(r.audit.gross_surplus, 40 + 30 + 40); // groceries 40 + transport 30 + entertainment 40
  assert.equal(r.audit.total_over, 40);
  assert.equal(r.cents.afterAbsorbC, 6000);
  assert.equal(r.audit.to_buffer, 40);              // room 40 < 55 (half of 110)
  assert.equal(r.audit.buffer_after, 100);
  assert.equal(r.audit.investable_cad, 70);
});

test('absorb_overspend off leaves the buffer alone', () => {
  const r = audit({
    user: user({ buffer_balance: 60, absorb_overspend: false }),
    txns: [txn('2026-11-09', 'groceries', 62), txn('2026-11-10', 'eating_out', 71),
      txn('2026-11-11', 'transport', 22), txn('2026-11-12', 'entertainment', 40)],
  });
  assert.equal(r.cents.afterAbsorbC, 6000);
  assert.equal(r.audit.to_buffer, 13);
  assert.equal(r.audit.buffer_after, 73);
  assert.equal(r.audit.investable_cad, 13);
});

test('full buffer: 100% of the surplus is investable; buffer above target is kept', () => {
  const full = audit({ user: user({ buffer_balance: 100 }), txns: [] });
  assert.equal(full.audit.gross_surplus, 200);
  assert.equal(full.audit.to_buffer, 0);
  assert.equal(full.audit.investable_cad, 200);
  const above = audit({ user: user({ buffer_balance: 150 }), txns: [] });
  assert.equal(above.audit.to_buffer, 0);
  assert.equal(above.audit.buffer_after, 150);
});

test('an odd number of cents rounds the cushion half-cent toward the buffer', () => {
  const r = audit({ user: user(), budgets: budgets([['groceries', 10.01]]), txns: [] });
  assert.equal(r.audit.to_buffer, 5.01);
  assert.equal(r.audit.investable_cad, 5);
});

// ---------- §6.7 carries, cap, minimum ----------

test('below min_invest: nothing invested, amount carried, then added next week', () => {
  const db = tables({
    users: [user({ buffer_balance: 100 })],
    budgetRows: budgets([['groceries', 80]]),
    transactions: [txn('2026-11-02', 'groceries', 76.5), txn('2026-11-09', 'groceries', 77)],
  });
  const w1 = run(db, { user_id: 'test-a', week_start: '2026-11-02' }).items[0];
  assert.equal(w1.audit.status, 'carried');
  assert.equal(w1.audit.investable_cad, 0);
  assert.equal(w1.audit.pending_carry_after, 3.5);
  assert.equal(w1.invest, false);
  assert.equal(w1.digest, true);
  assert.equal(db.users[0].pending_carry, 3.5);

  const w2 = run(db, { user_id: 'test-a', week_start: THIS_MONDAY }).items[0];
  assert.equal(w2.audit.gross_surplus, 3);
  assert.equal(w2.audit.investable_cad, 6.5); // 3 + 3.50 carried
  assert.equal(w2.audit.status, 'computed');
  assert.equal(w2.audit.pending_carry_after, 0);
  assert.equal(db.users[0].pending_carry, 0);
  assert.equal(w2.invest, true);
});

test('max_weekly_invest caps the amount (the excess is not carried)', () => {
  const r = audit({
    user: user({ buffer_balance: 100, pending_carry: 4.99 }),
    budgets: budgets([['groceries', 150], ['eating_out', 100]]),
    txns: [],
  });
  assert.equal(r.cents.rawC, 25499);
  assert.equal(r.audit.investable_cad, 200);
  assert.equal(r.audit.pending_carry_after, 0);
  assert.equal(r.userUpdate.pending_carry, 0);
});

// ---------- §6.6 late-posting true-up ----------

function lateScenario({ lateAmount, buffer = 100 }) {
  const db = tables({
    users: [user({ buffer_balance: buffer })],
    budgetRows: budgets([['groceries', 80], ['eating_out', 50]]),
    transactions: [txn('2026-11-03', 'groceries', 60), txn('2026-11-04', 'eating_out', 30)],
  });
  const w1 = run(db, { user_id: 'test-a', week_start: '2026-11-02', invest: false }).items[0];
  // A charge dated last week posts late, after last week was audited.
  db.transactions.push(txn('2026-11-08', 'eating_out', lateAmount));
  db.transactions.push(txn('2026-11-10', 'groceries', 75));
  const w2 = run(db, { user_id: 'test-a', week_start: THIS_MONDAY }).items[0];
  return { db, w1, w2 };
}

test('late posting shrinks last week: late_adj comes off this week', () => {
  const { db, w1, w2 } = lateScenario({ lateAmount: 12 });
  assert.equal(w1.audit.gross_surplus, 40);
  assert.equal(w2.audit.late_adj, 12);
  assert.equal(w2.audit.gross_surplus, 55);           // groceries 5 + eating_out 50
  assert.equal(w2.audit.investable_cad, 55 - 12);
  assert.equal(db.users[0].deficit_carry, 0);
});

test('late posting bigger than this week: investable 0, the rest becomes deficit_carry, then is repaid', () => {
  const { w2 } = lateScenario({ lateAmount: 400 });
  // last week's eating_out surplus was 20: it can shrink by at most 20
  assert.equal(w2.audit.late_adj, 20);
  assert.equal(w2.audit.investable_cad, 35);
  // a shortfall: rerun the scenario with a smaller week so 20 > what's left
  const db2 = tables({
    users: [user({ buffer_balance: 100 })],
    budgetRows: budgets([['groceries', 80], ['eating_out', 50]]),
    transactions: [txn('2026-11-03', 'groceries', 50), txn('2026-11-04', 'eating_out', 10)],
  });
  run(db2, { user_id: 'test-a', week_start: '2026-11-02', invest: false });
  db2.transactions.push(txn('2026-11-08', 'groceries', 30), txn('2026-11-08', 'eating_out', 40));
  db2.transactions.push(txn('2026-11-10', 'groceries', 78), txn('2026-11-11', 'eating_out', 49));
  const w = run(db2, { user_id: 'test-a', week_start: THIS_MONDAY }).items[0];
  assert.equal(w.audit.late_adj, 70);                  // 70 surplus shrank to 0
  assert.equal(w.audit.gross_surplus, 3);
  assert.equal(w.audit.investable_cad, 0);
  assert.equal(w.audit.status, 'carried');
  assert.equal(w.audit.pending_carry_after, 0);
  assert.equal(db2.users[0].deficit_carry, 67);
  // next week: a $130 surplus repays the 67 first
  const w3 = run(db2, { user_id: 'test-a', week_start: '2026-11-16' }, new Date('2026-11-22T23:00:00Z')).items[0];
  assert.equal(w3.audit.gross_surplus, 130);
  assert.equal(w3.audit.late_adj, 0);
  assert.equal(w3.audit.investable_cad, 63);
  assert.equal(db2.users[0].deficit_carry, 0);
});

test('surplus that grew later (late refund) adds nothing', () => {
  const r = audit({
    user: user({ buffer_balance: 100 }),
    txns: [txn('2026-11-02', 'groceries', -20)],
    prevAudit: { audit_id: 'test-a-2026-11-02', week_start: '2026-11-02', status: 'invested', gross_surplus: 10, lines_json: JSON.stringify([{ category_key: 'groceries', planned: 80, actual: 70, under: 10, over: 0 }]) },
  });
  assert.equal(r.audit.late_adj, 0);
});

test('no true-up against a skipped_paused week', () => {
  const { lateAdjC } = A.lateAdjustment(
    { week_start: '2026-11-02', status: 'skipped_paused', gross_surplus: 50, lines_json: JSON.stringify([{ category_key: 'groceries', planned: 80 }]) },
    [txn('2026-11-03', 'groceries', 80)],
  );
  assert.equal(lateAdjC, 0);
});

// ---------- planAudits: users, idempotency, validation ----------

test('paused user: skipped_paused row, balances untouched, no invest, no digest', () => {
  const db = tables({
    users: [user({ status: 'paused', buffer_balance: 30, pending_carry: 2 })],
    budgetRows: budgets([['groceries', 80]]),
    transactions: [txn('2026-11-10', 'groceries', 50)],
  });
  const plan = run(db, { user_id: 'test-a' });
  const [it] = plan.items;
  assert.equal(it.audit.status, 'skipped_paused');
  assert.equal(it.audit.gross_surplus, 30);    // shown, not moved
  assert.equal(it.audit.to_buffer, 0);
  assert.equal(it.audit.investable_cad, 0);
  assert.equal(it.audit.buffer_after, 30);
  assert.equal(it.audit.pending_carry_after, 2);
  assert.equal(it.user_update, null);
  assert.deepEqual([it.write, it.invest, it.digest], [true, false, false]);
  assert.equal(db.users[0].buffer_balance, 30);

  // resumed later the same week: the skipped_paused row is recomputed (it moved no money)
  db.users[0].status = 'active';
  const again = run(db, { user_id: 'test-a' }).items[0];
  assert.equal(again.kind, 'new');
  assert.equal(again.audit.status, 'computed');
  assert.equal(again.audit.investable_cad, 15 + 2);
});

test('week already invested: returned unchanged, nothing written or called', () => {
  const db = tables({ users: [user({ buffer_balance: 100 })], budgetRows: budgets([['groceries', 80]]), transactions: [] });
  run(db, { user_id: 'test-a' });
  db.audits[0].status = 'invested'; // what LO-05 does
  db.transactions.push(txn('2026-11-12', 'groceries', 70));
  const plan = run(db, { user_id: 'test-a' });
  const [it] = plan.items;
  assert.equal(it.kind, 'existing');
  assert.deepEqual([it.write, it.invest, it.digest], [false, false, false]);
  assert.equal(it.response.status, 'invested');
  assert.equal(it.response.investable_cad, 80);
  assert.equal(db.users[0].buffer_balance, 100);
});

test('rerun of a computed week: same numbers, no writes, LO-05 retried only when investing', () => {
  const db = tables({ users: [user({ buffer_balance: 60 })], budgetRows: B4, transactions: [] });
  const first = run(db, { user_id: 'test-a' }).items[0];
  const usersAfter = JSON.stringify(db.users);
  const auditsAfter = JSON.stringify(db.audits);
  const again = run(db, { user_id: 'test-a' }).items[0];
  assert.equal(again.kind, 'existing');
  assert.equal(again.write, false);
  assert.equal(again.invest, true);
  assert.equal(again.digest, false);
  assert.equal(again.investable_cad, first.audit.investable_cad);
  assert.deepEqual(again.response, first.response);
  assert.equal(JSON.stringify(db.users), usersAfter);
  assert.equal(JSON.stringify(db.audits), auditsAfter);
  const backfill = run(db, { user_id: 'test-a', invest: false }).items[0];
  assert.equal(backfill.invest, false);
});

test('default run: every active and paused user, current week, sorted', () => {
  const db = tables({
    users: [user({ user_id: 'zed' }), user({ user_id: 'amy', status: 'paused' }), user({ user_id: 'old', status: 'closed' })],
    budgetRows: [...budgets([['groceries', 80]], 'zed'), ...budgets([['groceries', 80]], 'amy')],
    transactions: [],
  });
  const plan = run(db, {});
  assert.equal(plan.week_start, THIS_MONDAY);
  assert.deepEqual(plan.items.map((i) => [i.user_id, i.audit.status]), [['amy', 'skipped_paused'], ['zed', 'computed']]);
});

test('validation errors', () => {
  const db = tables({ users: [user()], budgetRows: [], transactions: [] });
  const err = (req) => { const p = A.planAudits({ request: req, ...db, now: NOW }); return [p.status, p.error && p.error.code]; };
  assert.deepEqual(err({ user_id: 'nobody' }), [404, 'NOT_FOUND']);
  assert.deepEqual(err({ user_id: 7 }), [400, 'BAD_REQUEST']);
  assert.deepEqual(err({ week_start: '2026-11-10' }), [400, 'BAD_REQUEST']);  // a Tuesday
  assert.deepEqual(err({ week_start: '11/09/2026' }), [400, 'BAD_REQUEST']);
  assert.deepEqual(err({ week_start: '2026-11-16' }), [400, 'BAD_REQUEST']);  // next week
  assert.deepEqual(err({ invest: 'no' }), [400, 'BAD_REQUEST']);
  assert.equal(A.planAudits({ request: { week_start: '', invest: null }, ...db, now: NOW }).ok, true);
});

test('auditing an older week after a newer one is refused', () => {
  const db = tables({ users: [user()], budgetRows: budgets([['groceries', 80]]), transactions: [] });
  run(db, { user_id: 'test-a' });
  const p = A.planAudits({ request: { user_id: 'test-a', week_start: '2026-11-02' }, ...db, now: NOW });
  assert.equal(p.ok, false);
  assert.equal(p.status, 400);
  assert.match(p.error.message, /audit weeks in order/);
});

test('week boundaries use Vancouver time: Sunday 23:30 local is still that week', () => {
  const db = tables({ users: [user()], budgetRows: budgets([['groceries', 80]]), transactions: [] });
  const plan = A.planAudits({ request: {}, ...db, now: new Date('2026-11-16T06:30:00Z') }); // Sun 2026-11-15 23:30 Vancouver (UTC-7 all year since Nov 1 2026)
  assert.equal(plan.week_start, THIS_MONDAY);
});

// ---------- LO-05 answers ----------

test('readInvestResult copes with the stub, the real answer, and failures', () => {
  assert.deepEqual(A.readInvestResult({ ok: true, stub: true, workflow: 'LO-05' }), { data: { ok: true, stub: true, workflow: 'LO-05' }, invested: false });
  const data = { audit_id: 'maya-2026-11-09', status: 'invested', orders: [] };
  assert.deepEqual(A.readInvestResult(data), { data, invested: true });
  assert.deepEqual(A.readInvestResult({ ok: true, data }), { data, invested: true });
  const up = { ok: false, error: { code: 'UPSTREAM_ERROR', message: 'Alpaca down' }, data: { status: 'dry_run' } };
  assert.equal(A.readInvestResult(up).invested, false);
  assert.equal(A.readInvestResult({ error: 'Workflow failed' }).invested, false);
  // Lane B's LO-05 (n8n/notes/B.md): failures come back as data with an error object and leave the audit computed
  for (const status of ['dry_run', 'partial', 'failed']) {
    const r = { audit_id: 'maya-2026-11-09', status, orders: [], error: { code: 'UPSTREAM_ERROR', message: 'Alpaca credential missing' } };
    assert.deepEqual(A.readInvestResult(r), { data: r, invested: false }, status);
  }
  const again = { audit_id: 'maya-2026-11-09', status: 'invested', already_invested: true, orders: [] };
  assert.deepEqual(A.readInvestResult(again), { data: again, invested: true });
  assert.deepEqual(A.readInvestResult(null), { data: null, invested: false });
});

// ---------- the seed: Maya's 3 past weeks + this week ----------

function mayaDb() {
  return tables({
    users: [{ ...seed.user }],
    budgetRows: seed.budgets.map((b, i) => ({ id: i + 1, ...b })),
    transactions: seed.transactions.map(({ day_offset, ...t }) => ({ ...t, date: seedDate(day_offset, NOW), source: 'seed' })),
  });
}

test('backfill of Maya\'s 3 past weeks (invest: false) reproduces seed _expected', () => {
  const db = mayaDb();
  for (const exp of seed._expected.weeks) {
    const ws = addDays(THIS_MONDAY, exp.day_offset_start);
    const plan = run(db, { user_id: 'maya', week_start: ws, invest: false });
    assert.equal(plan.ok, true, JSON.stringify(plan.error));
    const [it] = plan.items;
    assert.deepEqual([it.write, it.invest, it.digest], [true, false, false]);
    const lines = Object.fromEntries(JSON.parse(it.audit.lines_json).map((l) => [l.category_key, l.actual]));
    assert.deepEqual(lines, exp.actual, ws);
    assert.deepEqual(
      [it.audit.gross_surplus, it.audit.total_over, it.audit.to_buffer, it.audit.buffer_after, it.audit.investable_cad, it.audit.late_adj, it.audit.status],
      [exp.gross_surplus, exp.total_over, exp.to_buffer, exp.buffer_after, exp.investable_cad, 0, 'computed'],
      ws,
    );
    assert.equal(db.users[0].buffer_balance, exp.buffer_after);
  }
  assert.deepEqual(db.audits.map((a) => a.audit_id), ['maya-2026-10-19', 'maya-2026-10-26', 'maya-2026-11-02']);
  assert.equal(db.users[0].pending_carry, 0);
  assert.equal(db.users[0].deficit_carry, 0);
});

test('backfill matches contracts/fixtures/audits.json row for row', () => {
  const fixture = JSON.parse(readFileSync(new URL('../contracts/fixtures/audits.json', import.meta.url))).data.audits;
  const db = mayaDb();
  for (const exp of seed._expected.weeks) run(db, { user_id: 'maya', week_start: addDays(THIS_MONDAY, exp.day_offset_start), invest: false });
  for (const f of fixture) {
    const row = db.audits.find((a) => a.audit_id === f.audit_id);
    const r = A.auditResponse(row);
    for (const k of ['week_start', 'gross_surplus_cad', 'total_over_cad', 'late_adj_cad', 'to_buffer_cad', 'buffer_after_cad', 'investable_cad', 'pending_carry_after_cad']) {
      assert.equal(r[k], f[k], `${f.audit_id} ${k}`);
    }
    assert.equal(row.week_end, f.week_end);
    assert.deepEqual(JSON.parse(row.lines_json).map((l) => [l.category_key, l.label, l.planned, l.actual, l.under, l.over]),
      f.lines.map((l) => [l.category_key, l.label, l.planned_cad, l.actual_cad, l.under_cad, l.over_cad]));
  }
});

test('Maya\'s current week after the backfill, then a rerun changes nothing', () => {
  const db = mayaDb();
  for (const exp of seed._expected.weeks) run(db, { user_id: 'maya', week_start: addDays(THIS_MONDAY, exp.day_offset_start), invest: false });
  const [it] = run(db, { user_id: 'maya' }).items;
  const lines = Object.fromEntries(JSON.parse(it.audit.lines_json).map((l) => [l.category_key, l.actual]));
  assert.deepEqual(lines, seed._expected.current_week_so_far);
  // under: 38.80 + 20.50 + 22 + 40 + 20 + 20 = 161.30; over: eating out 8.40
  // buffer 41.00 - 8.40 = 32.60; to_buffer = min(80.65, 67.40) = 67.40 → buffer 100
  assert.deepEqual(
    [it.audit.gross_surplus, it.audit.total_over, it.audit.to_buffer, it.audit.buffer_after, it.audit.late_adj, it.audit.investable_cad, it.audit.status],
    [161.3, 8.4, 67.4, 100, 0, 93.9, 'computed'],
  );
  assert.deepEqual([it.invest, it.digest], [true, true]);
  const snapshot = JSON.stringify([db.users, db.audits]);
  const again = run(db, { user_id: 'maya' }).items[0];
  assert.equal(again.kind, 'existing');
  assert.deepEqual(again.response, it.response);
  assert.equal(JSON.stringify([db.users, db.audits]), snapshot);
});

// ---------- the Code nodes in LO-04 carry this file verbatim ----------

test('LO-04 Code nodes embed lib/week.mjs and lib/audit.mjs verbatim', () => {
  const wf = JSON.parse(readFileSync(new URL('../n8n/workflows/04-weekly-audit.json', import.meta.url)));
  assert.equal(wf.id, 'leftoverWF04audt');
  const code = (name) => {
    const node = wf.nodes.find((n) => n.name === name);
    assert.ok(node, `node "${name}" missing`);
    return node.parameters.jsCode;
  };
  const body = (file) => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    return src.slice(0, src.lastIndexOf('\nexport {')).trimEnd();
  };
  const compute = code('Compute audits');
  assert.ok(compute.includes(body('./week.mjs')), 'Compute audits: lib/week.mjs is out of date, re-paste it');
  assert.ok(compute.includes(body('./audit.mjs')), 'Compute audits: lib/audit.mjs is out of date, re-paste it');
  assert.ok(compute.includes('auditSelfTest();'), 'Compute audits must run the inline self-test');
  assert.ok(code('Build response').includes(A.readInvestResult.toString()), 'Build response: readInvestResult is out of date');
});
