// Checks demo/seed-data.json adds up to its own _expected block (spec §6, §19.4).
// Independent re-implementation in integer cents, so Lane A has a second opinion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const seed = JSON.parse(readFileSync(new URL('../demo/seed-data.json', import.meta.url)));
const cents = (x) => Math.round(x * 100);
const keys = seed.budgets.map((b) => b.category_key);
const planned = Object.fromEntries(seed.budgets.map((b) => [b.category_key, cents(b.weekly_amount)]));

function actualByCategory(start) {
  const txns = seed.transactions.filter((t) => t.day_offset >= start && t.day_offset <= start + 6 && !t.removed);
  const superseded = new Set(txns.filter((t) => t.pending_txn_id).map((t) => t.pending_txn_id));
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const t of txns) {
    if (superseded.has(t.txn_id) || !(t.category_key in out)) continue;
    out[t.category_key] += cents(t.amount);
  }
  return out;
}

test('every transaction uses a known category and a unique id', () => {
  const ids = new Set();
  for (const t of seed.transactions) {
    assert.ok(!ids.has(t.txn_id), `duplicate ${t.txn_id}`);
    ids.add(t.txn_id);
    assert.ok(keys.includes(t.category_key) || t.category_key === 'excluded', `${t.txn_id}: ${t.category_key}`);
    assert.ok(t.day_offset >= -21 && t.day_offset <= 6, `${t.txn_id}: offset ${t.day_offset}`);
  }
});

test('category_map agrees with every seeded transaction', () => {
  const map = seed.category_map;
  for (const t of seed.transactions) {
    const row = map.find((r) => r.plaid_pfc_primary === t.pfc_primary && r.plaid_pfc_detailed === t.pfc_detailed)
      ?? map.find((r) => r.plaid_pfc_primary === t.pfc_primary && r.plaid_pfc_detailed === '');
    assert.ok(row, `${t.txn_id}: no category_map row for ${t.pfc_primary}`);
    assert.equal(row.category_key, t.category_key, `${t.txn_id}`);
  }
});

test('past weeks reproduce _expected (cushion 50%, absorb ON, buffer starts at 0)', () => {
  const u = seed.user;
  let buffer = cents(u.buffer_balance);
  for (const exp of seed._expected.weeks) {
    const actual = actualByCategory(exp.day_offset_start);
    for (const k of keys) assert.equal(actual[k], cents(exp.actual[k]), `${exp.day_offset_start} ${k}`);
    let gross = 0; let over = 0;
    for (const k of keys) {
      gross += Math.max(planned[k] - actual[k], 0);
      over += Math.max(actual[k] - planned[k], 0);
    }
    assert.equal(gross % 2, 0, 'gross cents must be even so the 50% split has no half-cent');
    if (u.absorb_overspend) buffer = Math.max(buffer - over, 0);
    assert.equal(buffer, cents(exp.buffer_after_absorb));
    const toBuffer = Math.min(gross * u.cushion_rate, cents(u.buffer_target) - buffer);
    buffer += toBuffer;
    const investable = Math.min(gross - toBuffer, cents(u.max_weekly_invest));
    assert.deepEqual(
      [gross, over, toBuffer, buffer, investable],
      [exp.gross_surplus, exp.total_over, exp.to_buffer, exp.buffer_after, exp.investable_cad].map(cents),
    );
  }
});

test('current week so far matches the demo story', () => {
  const actual = actualByCategory(0);
  for (const k of keys) assert.equal(actual[k], cents(seed._expected.current_week_so_far[k]), k);
  assert.ok(actual.groceries < planned.groceries, 'under on groceries');
  assert.ok(actual.eating_out > planned.eating_out, 'over on eating out');
});

test('allocation weights sum to 1', () => {
  const sum = Object.values(seed.profile.allocation).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 1e6), 1e6);
});
