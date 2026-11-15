// Keeps contracts/fixtures consistent with each other and with demo/seed-data.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const seed = read('../demo/seed-data.json');
const fx = (name) => read(`../contracts/fixtures/${name}.json`);
const c = (x) => Math.round(x * 100);
const sum = (arr, f) => arr.reduce((a, x) => a + c(f(x)), 0) / 100;

test('every fixture parses and uses the envelope', () => {
  for (const f of readdirSync(new URL('../contracts/fixtures/', import.meta.url))) {
    const j = read(`../contracts/fixtures/${f}`);
    assert.equal(typeof j.ok, 'boolean', f);
    assert.ok(j.ok ? j.data : j.error?.code, f);
  }
});

test('summary lines match the seed and add up', () => {
  const s = fx('summary').data;
  for (const l of s.lines) {
    assert.equal(l.actual_cad, seed._expected.current_week_so_far[l.category_key], l.category_key);
    assert.equal(c(l.remaining_cad), Math.max(c(l.planned_cad) - c(l.actual_cad), 0), l.category_key);
    assert.equal(c(l.over_cad), Math.max(c(l.actual_cad) - c(l.planned_cad), 0), l.category_key);
  }
  assert.equal(s.totals.actual_cad, sum(s.lines, (l) => l.actual_cad));
  assert.equal(s.totals.remaining_cad, sum(s.lines, (l) => l.remaining_cad));
  assert.equal(s.totals.projected_leftover_cad, sum(s.lines, (l) => l.projected_under_cad));
  assert.equal(s.buffer.balance_cad, seed._expected.weeks.at(-1).buffer_after);
});

test('audits match the seed _expected weeks (newest first)', () => {
  const a = fx('audits').data;
  const expected = [...seed._expected.weeks].reverse();
  a.audits.forEach((audit, i) => {
    const e = expected[i];
    assert.equal(audit.gross_surplus_cad, e.gross_surplus);
    assert.equal(audit.total_over_cad, e.total_over);
    assert.equal(audit.to_buffer_cad, e.to_buffer);
    assert.equal(audit.buffer_after_cad, e.buffer_after);
    assert.equal(audit.investable_cad, e.investable_cad);
    for (const l of audit.lines) assert.equal(l.actual_cad, e.actual[l.category_key], `${audit.audit_id} ${l.category_key}`);
    assert.equal(audit.gross_surplus_cad, sum(audit.lines, (l) => l.under_cad));
  });
  assert.equal(a.totals.invested_cad, sum(a.audits, (x) => x.investable_cad));
});

test('portfolio orders add up to what was invested', () => {
  for (const name of ['portfolio', 'portfolio-queued']) {
    const p = fx(name).data;
    assert.equal(p.totals.contributed_cad, sum(p.orders, (o) => o.notional_cad), name);
    for (const audit of fx('audits').data.audits) {
      const orders = p.orders.filter((o) => o.audit_id === audit.audit_id);
      assert.equal(sum(orders, (o) => o.notional_cad), audit.investable_cad, `${name} ${audit.audit_id}`);
    }
    assert.equal(p.totals.queued_usd, sum(p.orders.filter((o) => o.status === 'queued'), (o) => o.notional_usd), name);
  }
});

test('projection uses FV = amount x (1+r)^years', () => {
  const p = fx('projection').data;
  for (const [rate, rows] of Object.entries(p.lifetime.by_rate)) {
    for (const { years, value_cad } of rows) {
      assert.equal(value_cad, Math.round(p.lifetime.contributed_cad * (1 + Number(rate)) ** years * 100) / 100);
    }
  }
  assert.equal(p.lifetime.contributed_cad, fx('summary').data.lifetime.invested_cad);
});
