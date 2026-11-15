// node --test lib/categorize.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  toBool, cents, isCalendarYmd, buildCategoryIndex, categorize, mapPlaidTransaction,
  mapSyncPages, rowsToWrite, plaidBaseUrl, buildSandboxTransaction, plaidError, syncReply, countableTransactions,
  buildManualExpense,
} from './categorize.mjs';

const root = new URL('../', import.meta.url);
const seed = JSON.parse(readFileSync(new URL('demo/seed-data.json', root), 'utf8'));
const sample = JSON.parse(readFileSync(new URL('lib/categorize.sample-sync.json', root), 'utf8'));
const index = buildCategoryIndex(seed.category_map);
const SYNCED = '2026-11-14T20:00:00.000-08:00';
const ctx = (cursor = '') => ({ user_id: 'test-c', index, synced_at: SYNCED, cursor });
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.txn_id, r]));

// ---------- helpers ----------
test('toBool reads Data Table booleans', () => {
  for (const v of [true, 1, '1', 'true', 'TRUE', 'yes']) assert.equal(toBool(v), true, String(v));
  for (const v of [false, 0, '0', 'false', '', null, undefined]) assert.equal(toBool(v), false, String(v));
});

test('cents rounds to the cent, both signs', () => {
  assert.equal(cents(14.005), 14.01);
  assert.equal(cents(-14.005), -14.01);
  assert.equal(cents('6.4'), 6.4);
  assert.equal(cents(-0.001), 0);
  assert.throws(() => cents('abc'));
});

test('isCalendarYmd rejects impossible dates', () => {
  assert.equal(isCalendarYmd('2026-11-14'), true);
  assert.equal(isCalendarYmd('2026-02-30'), false);
  assert.equal(isCalendarYmd('2026-11-14T00:00:00Z'), false);
  assert.equal(isCalendarYmd(null), false);
});

// ---------- categorize (spec §9 lookup order) against the seed's category_map ----------
test('exact (primary, detailed) wins over the primary default', () => {
  assert.deepEqual(categorize('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES', index),
    { category_key: 'groceries', excluded: false, rule: 'detailed' });
  assert.deepEqual(categorize('FOOD_AND_DRINK', 'FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR', index),
    { category_key: 'other', excluded: false, rule: 'detailed' });
});

test('primary default covers every other detailed value', () => {
  for (const d of ['FOOD_AND_DRINK_RESTAURANT', 'FOOD_AND_DRINK_FAST_FOOD', 'FOOD_AND_DRINK_COFFEE', 'FOOD_AND_DRINK_VENDING_MACHINES', 'FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK']) {
    assert.equal(categorize('FOOD_AND_DRINK', d, index).category_key, 'eating_out', d);
  }
  assert.equal(categorize('TRANSPORTATION', 'TRANSPORTATION_GAS', index).category_key, 'transport');
  assert.equal(categorize('ENTERTAINMENT', 'ENTERTAINMENT_TV_AND_MOVIES', index).category_key, 'entertainment');
  assert.equal(categorize('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', index).category_key, 'shopping');
  assert.equal(categorize('HOME_IMPROVEMENT', 'HOME_IMPROVEMENT_HARDWARE', index).category_key, 'shopping');
  assert.equal(categorize('PERSONAL_CARE', 'PERSONAL_CARE_HAIR_AND_BEAUTY', index).category_key, 'personal_care');
  assert.equal(categorize('MEDICAL', 'MEDICAL_PHARMACIES_AND_SUPPLEMENTS', index).category_key, 'other');
  assert.equal(categorize('TRAVEL', 'TRAVEL_FLIGHTS', index).category_key, 'other');
});

test('fixed costs, transfers and income are excluded', () => {
  for (const p of ['RENT_AND_UTILITIES', 'TRANSFER_IN', 'TRANSFER_OUT', 'INCOME', 'LOAN_PAYMENTS', 'BANK_FEES', 'GENERAL_SERVICES', 'GOVERNMENT_AND_NON_PROFIT']) {
    assert.deepEqual(categorize(p, `${p}_SOMETHING`, index), { category_key: 'excluded', excluded: true, rule: 'primary' }, p);
  }
});

test('unmapped or missing PFC falls back to other', () => {
  assert.deepEqual(categorize('OTHER', 'OTHER_OTHER', index), { category_key: 'other', excluded: false, rule: 'fallback' });
  assert.deepEqual(categorize(null, null, index), { category_key: 'other', excluded: false, rule: 'fallback' });
  assert.deepEqual(categorize('', '', index), { category_key: 'other', excluded: false, rule: 'fallback' });
});

test('lookup ignores case and whitespace', () => {
  assert.equal(categorize(' food_and_drink ', 'food_and_drink_groceries', index).category_key, 'groceries');
});

test('every PFC v2 primary resolves (seed coverage check)', () => {
  // The 18 PFCv2 primaries (plaid.com/documents/pfc-taxonomy-all.csv, checked 2026-11-14).
  const v2 = ['INCOME', 'LOAN_DISBURSEMENTS', 'LOAN_PAYMENTS', 'TRANSFER_IN', 'TRANSFER_OUT', 'BANK_FEES',
    'ENTERTAINMENT', 'FOOD_AND_DRINK', 'GENERAL_MERCHANDISE', 'HOME_IMPROVEMENT', 'MEDICAL', 'PERSONAL_CARE',
    'GENERAL_SERVICES', 'GOVERNMENT_AND_NON_PROFIT', 'TRANSPORTATION', 'TRAVEL', 'RENT_AND_UTILITIES', 'OTHER'];
  const unmapped = v2.filter((p) => categorize(p, '', index).rule === 'fallback');
  // OTHER is meant to fall back to "other". LOAN_DISBURSEMENTS has an excluded row, so loan
  // money coming in (a negative amount) never looks like a refund (spec §6.2).
  assert.deepEqual(unmapped, ['OTHER']);
  assert.equal(categorize('LOAN_DISBURSEMENTS', '', index).category_key, 'excluded');
});

test('index: excluded flag forces category "excluded"; later duplicate rows win', () => {
  const idx = buildCategoryIndex([
    { plaid_pfc_primary: 'TRAVEL', plaid_pfc_detailed: '', category_key: 'other', excluded: 0 },
    { plaid_pfc_primary: 'TRAVEL', plaid_pfc_detailed: '', category_key: 'transport', excluded: 1 },
    { plaid_pfc_primary: '', plaid_pfc_detailed: '', category_key: 'groceries', excluded: false },
  ]);
  assert.deepEqual(categorize('TRAVEL', 'TRAVEL_FLIGHTS', idx), { category_key: 'excluded', excluded: true, rule: 'primary' });
  assert.equal(idx.size, 1);
});

// ---------- one transaction ----------
test('mapPlaidTransaction builds a transactions row', () => {
  const t = sample.run_1.pages[0].added[0];
  assert.deepEqual(mapPlaidTransaction(t, ctx()), {
    txn_id: 'txn-groc-1', user_id: 'test-c', date: '2026-11-10', amount: 62.15, merchant: 'Save-On-Foods',
    pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: 'FOOD_AND_DRINK_GROCERIES', category_key: 'groceries',
    pending: false, pending_txn_id: '', source: 'plaid', removed: false, synced_at: SYNCED,
  });
});

test('date = authorized_date when present, else the posted date', () => {
  const [, , , payroll] = sample.run_1.pages[0].added;
  assert.equal(mapPlaidTransaction(payroll, ctx()).date, '2026-11-06');
  assert.equal(mapPlaidTransaction({ ...payroll, authorized_date: '2026-11-05' }, ctx()).date, '2026-11-05');
});

test('sign convention: Plaid positive = money out is kept; refunds stay negative', () => {
  const refund = sample.run_1.pages[1].added[1];
  const row = mapPlaidTransaction(refund, ctx());
  assert.equal(row.amount, -35);
  assert.equal(row.category_key, 'shopping');
});

test('merchant falls back to name, then Unknown', () => {
  const rent = sample.run_1.pages[0].added[2];
  assert.equal(mapPlaidTransaction(rent, ctx()).merchant, 'E-TRANSFER RENT NOV');
  assert.equal(mapPlaidTransaction({ ...rent, name: '  ' }, ctx()).merchant, 'Unknown');
});

test('mapPlaidTransaction rejects records it cannot store', () => {
  assert.throws(() => mapPlaidTransaction({ amount: 1, date: '2026-11-10' }, ctx()), /transaction_id/);
  assert.throws(() => mapPlaidTransaction({ transaction_id: 'x', amount: 1, date: 'yesterday' }, ctx()), /date/);
  assert.throws(() => mapPlaidTransaction({ transaction_id: 'x', amount: 'n/a', date: '2026-11-10' }, ctx()), /amount/);
});

// ---------- a whole sync run ----------
test('run 1: two pages, added + modified, cursor from the last page', () => {
  const out = mapSyncPages(sample.run_1.pages, ctx(sample.run_1.cursor_before));
  assert.equal(out.complete, true);
  assert.equal(out.not_ready, false);
  assert.equal(out.next_cursor, 'cursor-run1-p2');
  assert.deepEqual(out.counts, { added: 12, modified: 1, removed: 0 });
  assert.deepEqual(out.removals, []);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /transaction_id/);

  const rows = byId(out.upserts);
  assert.equal(out.upserts.length, 11);
  assert.equal(rows['txn-uber-1'].amount, 19.1, 'modified in a later page wins');
  assert.equal(rows['txn-coffee-pending'].pending, true);
  assert.deepEqual(
    Object.fromEntries(out.upserts.map((r) => [r.txn_id, r.category_key])),
    {
      'txn-groc-1': 'groceries', 'txn-coffee-pending': 'eating_out', 'txn-rent-nov': 'excluded',
      'txn-payroll-1': 'excluded', 'txn-liquor-1': 'other', 'txn-uber-1': 'transport', 'txn-no-pfc': 'other',
      'txn-loan-disb': 'excluded', 'txn-refund-1': 'shopping', 'txn-netflix-1': 'entertainment', 'txn-other-v2': 'other',
    },
  );
  for (const r of out.upserts) {
    assert.equal(r.user_id, 'test-c');
    assert.equal(r.source, 'plaid');
    assert.equal(r.removed, false);
  }
});

test('run 2: pending → posted, correction, reversal', () => {
  const out = mapSyncPages(sample.run_2.pages, ctx(sample.run_2.cursor_before));
  assert.equal(out.next_cursor, 'cursor-run2-p1');
  assert.deepEqual(out.counts, { added: 1, modified: 1, removed: 2 });
  const rows = byId(out.upserts);
  assert.deepEqual(Object.keys(rows).sort(), ['txn-coffee-posted', 'txn-groc-1']);
  assert.equal(rows['txn-coffee-posted'].pending, false);
  assert.equal(rows['txn-coffee-posted'].pending_txn_id, 'txn-coffee-pending');
  assert.equal(rows['txn-coffee-posted'].date, '2026-11-12', 'posted row keeps the purchase day');
  assert.equal(rows['txn-groc-1'].amount, 61.15);
  assert.deepEqual(out.removals.sort(), ['txn-coffee-pending', 'txn-no-pfc']);
});

test('pending and posted in the same run: the pending row is stored as removed', () => {
  const pages = [...sample.run_1.pages, ...sample.run_2.pages];
  const out = mapSyncPages(pages, ctx(''));
  const rows = byId(out.upserts);
  assert.equal(rows['txn-coffee-pending'].removed, true);
  assert.equal(rows['txn-no-pfc'].removed, true);
  assert.equal(rows['txn-coffee-posted'].removed, false);
  assert.deepEqual(out.removals, []);
  assert.equal(out.next_cursor, 'cursor-run2-p1');
});

test('a posted row supersedes its pending row even if Plaid omits the removal', () => {
  const posted = sample.run_2.pages[0].added[0];
  const out = mapSyncPages([{ added: [posted], modified: [], removed: [], next_cursor: 'c2', has_more: false }], ctx('c1'));
  assert.deepEqual(out.removals, ['txn-coffee-pending']);
});

test('removed then re-added in a later page is live again', () => {
  const t = sample.run_1.pages[0].added[0];
  const out = mapSyncPages([
    { added: [], modified: [], removed: [{ transaction_id: t.transaction_id }], next_cursor: 'a', has_more: true },
    { added: [t], modified: [], removed: [], next_cursor: 'b', has_more: false },
  ], ctx(''));
  assert.deepEqual(out.removals, []);
  assert.equal(out.upserts[0].removed, false);
});

test('NOT_READY: nothing to write and the stored cursor stays as it was', () => {
  const out = mapSyncPages(sample.not_ready.pages, ctx(''));
  assert.equal(out.not_ready, true);
  assert.equal(out.complete, true);
  assert.equal(out.next_cursor, '');
  assert.deepEqual([out.upserts, out.removals], [[], []]);
});

test('NOT_READY pages before the real ones (polling) do not matter', () => {
  const out = mapSyncPages([...sample.not_ready.pages, ...sample.run_1.pages], ctx(''));
  assert.equal(out.not_ready, false);
  assert.equal(out.next_cursor, 'cursor-run1-p2');
  assert.equal(out.upserts.length, 11);
});

test('incomplete run (has_more still true): rows are written, cursor is not saved', () => {
  const out = mapSyncPages(sample.incomplete.pages, ctx(sample.incomplete.cursor_before));
  assert.equal(out.complete, false);
  assert.equal(out.next_cursor, null);
  assert.equal(out.upserts.length, 1);
});

test('an empty page keeps the stored cursor; no pages at all is a no-op', () => {
  assert.equal(mapSyncPages([{ added: [], modified: [], removed: [], next_cursor: 'c9', has_more: false }], ctx('c9')).next_cursor, 'c9');
  const none = mapSyncPages([], ctx('c9'));
  assert.equal(none.next_cursor, 'c9');
  assert.equal(none.complete, true);
});

// ---------- what one sync run writes ----------
test('rowsToWrite: removals become full stored rows with removed = true', () => {
  const r1 = mapSyncPages(sample.run_1.pages, ctx(''));
  // What a Data Table get returns: our columns plus n8n's id/createdAt/updatedAt, booleans, ISO dates.
  const stored = r1.upserts.map((r, i) => ({ ...r, id: i + 1, createdAt: 'x', updatedAt: 'y', pending: r.pending ? 1 : 0, removed: 0, synced_at: '2026-11-13T10:00:00.000Z' }));
  const r2 = mapSyncPages(sample.run_2.pages, ctx(r1.next_cursor));
  const rows = rowsToWrite(r2, stored, SYNCED);
  const out = byId(rows);
  assert.deepEqual(Object.keys(out).sort(), ['txn-coffee-pending', 'txn-coffee-posted', 'txn-groc-1', 'txn-no-pfc']);
  assert.deepEqual(out['txn-coffee-pending'], {
    txn_id: 'txn-coffee-pending', user_id: 'test-c', date: '2026-11-12', amount: 6.45, merchant: 'Starbucks',
    pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: 'FOOD_AND_DRINK_COFFEE', category_key: 'eating_out',
    pending: true, pending_txn_id: '', source: 'plaid', removed: true, synced_at: SYNCED,
  });
  assert.equal(out['txn-no-pfc'].removed, true);
  assert.equal(out['txn-coffee-posted'].removed, false);
});

test('rowsToWrite: unknown or already-removed ids are skipped', () => {
  const res = { upserts: [], removals: ['never-seen', 'gone'] };
  const rows = rowsToWrite(res, [{ txn_id: 'gone', removed: 1 }], SYNCED);
  assert.deepEqual(rows, []);
});

test('plaidBaseUrl: sandbox only', () => {
  assert.equal(plaidBaseUrl(seed.config), 'https://sandbox.plaid.com');
  assert.equal(plaidBaseUrl([]), 'https://sandbox.plaid.com');
  assert.equal(plaidBaseUrl([{ key: 'plaid_base_url', value: 'https://sandbox.plaid.com/' }]), 'https://sandbox.plaid.com');
  assert.throws(() => plaidBaseUrl([{ key: 'plaid_base_url', value: 'https://production.plaid.com' }]), /sandbox/);
});

test('buildSandboxTransaction: contract body → Plaid transaction', () => {
  assert.deepEqual(buildSandboxTransaction({ user_id: 'test-c', merchant: 'Banh Mi Saigon', amount_cad: 14 }, '2026-11-14'), {
    ok: true, user_id: 'test-c',
    transaction: { date_transacted: '2026-11-14', date_posted: '2026-11-14', amount: 14, description: 'Banh Mi Saigon' },
  });
  const cases = [
    [{ merchant: 'x', amount_cad: 1 }, /user_id/],
    [{ user_id: 'test-c', amount_cad: 1 }, /merchant/],
    [{ user_id: 'test-c', merchant: 'x', amount_cad: 0 }, /amount_cad/],
    [{ user_id: 'test-c', merchant: 'x', amount_cad: 50000 }, /too large/],
    [{ user_id: 'test-c', merchant: 'x', amount_cad: 1, date: '2026-11-15' }, /future/],
    [{ user_id: 'test-c', merchant: 'x', amount_cad: 1, date: '2024-11-13' }, /730/],
    [{ user_id: 'test-c', merchant: 'x', amount_cad: 1, date: '14/11/2026' }, /YYYY-MM-DD/],
  ];
  for (const [input, re] of cases) {
    const out = buildSandboxTransaction(input, '2026-11-14');
    assert.equal(out.ok, false);
    assert.equal(out.status, 400);
    assert.match(out.message, re);
  }
});

test('plaidError: unwraps the Plaid JSON n8n puts in error.message', () => {
  // Shape captured from a real sandbox.plaid.com reply (placeholder keys), 2026-11-14.
  const plaid = { display_message: null, error_code: 'INVALID_FIELD', error_message: 'client_id must be a properly formatted, non-empty string', error_type: 'INVALID_REQUEST', request_id: 'c869cf03d807387' };
  const item = { route: 0, user_id: 'test-c', error: { message: `400 - ${JSON.stringify(JSON.stringify(plaid, null, 2))}`, name: 'AxiosError' } };
  assert.deepEqual(plaidError(item), { code: 'INVALID_FIELD', message: 'Plaid said INVALID_FIELD: client_id must be a properly formatted, non-empty string' });
  // With pagination on, n8n puts the body in error.error instead (shape captured from LO-03).
  const paged = { route: 1, error: { statusCode: 400, error: JSON.stringify({ error_type: 'TRANSACTIONS_ERROR', error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', error_message: 'Underlying transaction data changed since last page was fetched. Please restart pagination from last update.' }), isAxiosError: true }, details: { message: '' } };
  assert.equal(plaidError(paged).code, 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
  assert.match(plaidError(paged).message, /restart pagination/);
  assert.deepEqual(plaidError({ error: { message: 'something mentions error_code: ITEM_LOGIN_REQUIRED here' } }), { code: 'ITEM_LOGIN_REQUIRED', message: 'Plaid said ITEM_LOGIN_REQUIRED' });
  assert.equal(plaidError({ error: { message: 'Credentials not found' } }).code, 'PLAID_REQUEST_FAILED');
  assert.match(plaidError({ error: { message: 'Credentials not found' } }).message, /Credentials not found/);
  assert.equal(plaidError({}).code, 'PLAID_REQUEST_FAILED');
});

test('syncReply: /lo/sync, internal and add-txn shapes', () => {
  const results = [
    { user_id: 'test-c', item_id: 'i1', ok: true, counts: { added: 3, modified: 1, removed: 0 } },
    { user_id: 'test-c', item_id: 'i2', ok: true, counts: { added: 1, modified: 0, removed: 2 } },
    { user_id: 'test-x', item_id: 'i3', ok: true, counts: { added: 0, modified: 0, removed: 0 } },
  ];
  assert.deepEqual(syncReply({ channel: 'api' }, results), { status: 200, body: { ok: true, data: { users: 2, added: 4, modified: 1, removed: 2 } } });
  assert.deepEqual(syncReply({ channel: 'internal', user_id: 'test-c' }, results.slice(0, 1)).body.data, { users: 1, added: 3, modified: 1, removed: 0 });
  assert.deepEqual(syncReply({ channel: 'add-txn', user_id: 'test-c' }, results.slice(0, 1)).body.data, { user_id: 'test-c', sync: { added: 3, modified: 1, removed: 0 } });
  assert.deepEqual(syncReply({ channel: 'api' }, []).body.data, { users: 0, added: 0, modified: 0, removed: 0 });
});

test('syncReply: not_ready is flagged; any failed link is a 502', () => {
  const nr = syncReply({ channel: 'internal' }, [{ user_id: 'test-c', item_id: 'i1', ok: true, not_ready: true, counts: { added: 0, modified: 0, removed: 0 } }]);
  assert.deepEqual(nr.body.data, { users: 1, added: 0, modified: 0, removed: 0, not_ready: true });
  const bad = syncReply({ channel: 'api' }, [
    { user_id: 'test-c', item_id: 'i1', ok: true, counts: { added: 1, modified: 0, removed: 0 } },
    { user_id: 'test-c', item_id: 'i2', ok: false, error: 'ITEM_LOGIN_REQUIRED' },
  ]);
  assert.equal(bad.status, 502);
  assert.equal(bad.body.error.code, 'UPSTREAM_ERROR');
  assert.match(bad.body.error.message, /i2: ITEM_LOGIN_REQUIRED/);
});

// ---------- what counts (pending → posted dedupe) ----------
test('countableTransactions: removed, excluded and superseded rows never count', () => {
  const r1 = mapSyncPages(sample.run_1.pages, ctx(''));
  // Table state after run 1 + run 2: apply run 2 on top of run 1.
  const table = new Map(r1.upserts.map((r) => [r.txn_id, r]));
  const r2 = mapSyncPages(sample.run_2.pages, ctx(r1.next_cursor));
  for (const r of r2.upserts) table.set(r.txn_id, r);
  for (const id of r2.removals) if (table.has(id)) table.set(id, { ...table.get(id), removed: true });

  const ids = countableTransactions([...table.values()]).map((r) => r.txn_id).sort();
  assert.deepEqual(ids, ['txn-coffee-posted', 'txn-groc-1', 'txn-liquor-1', 'txn-netflix-1', 'txn-other-v2', 'txn-refund-1', 'txn-uber-1']);
});

test('countableTransactions: a superseded pending row is dropped even if not flagged removed', () => {
  const rows = [
    { txn_id: 'p', category_key: 'eating_out', pending: true, pending_txn_id: '', removed: false },
    { txn_id: 'q', category_key: 'eating_out', pending: false, pending_txn_id: 'p', removed: 0 },
    { txn_id: 'r', category_key: 'groceries', pending: true, pending_txn_id: '', removed: '0' },
  ];
  assert.deepEqual(countableTransactions(rows).map((r) => r.txn_id), ['q', 'r']);
});

// ---------- manual expense (LO-03b) ----------
const budgets = seed.budgets.map((b) => ({ ...b, user_id: 'test-c' }));
const mctx = { today: '2026-11-14', now: '2026-11-14T12:00:00.000-08:00', id_suffix: 'abc123' };

test('manual expense: happy path matches the contract', () => {
  const out = buildManualExpense({ user_id: 'test-c', amount_cad: 14, category_key: 'eating_out', merchant: 'Banh Mi Saigon', date: '2026-11-14' }, budgets, mctx);
  assert.equal(out.ok, true);
  assert.deepEqual(out.data, { txn_id: 'manual-test-c-abc123', user_id: 'test-c', date: '2026-11-14', amount_cad: 14, category_key: 'eating_out' });
  assert.deepEqual(out.row, {
    txn_id: 'manual-test-c-abc123', user_id: 'test-c', date: '2026-11-14', amount: 14, merchant: 'Banh Mi Saigon',
    pfc_primary: '', pfc_detailed: '', category_key: 'eating_out', pending: false, pending_txn_id: '',
    source: 'manual', removed: false, synced_at: mctx.now,
  });
});

test('manual expense: date defaults to today; label and "$" amounts are accepted (the form)', () => {
  const out = buildManualExpense({ user_id: 'test-c', amount_cad: '$1,234.565', category: 'Eating out and coffee', merchant: ' Cafe ' }, budgets, mctx);
  assert.equal(out.ok, true);
  assert.equal(out.row.date, '2026-11-14');
  assert.equal(out.row.amount, 1234.57);
  assert.equal(out.row.category_key, 'eating_out');
  assert.equal(out.row.merchant, 'Cafe');
});

test('manual expense: a negative amount is a refund', () => {
  const out = buildManualExpense({ user_id: 'test-c', amount_cad: -20, category_key: 'shopping', merchant: 'Uniqlo' }, budgets, mctx);
  assert.equal(out.row.amount, -20);
});

test('manual expense: validation errors', () => {
  const ok = { user_id: 'test-c', amount_cad: 14, category_key: 'eating_out', merchant: 'X' };
  const cases = [
    [{ ...ok, user_id: '' }, 400, /user_id/],
    [{ ...ok, user_id: 'Bad User!' }, 400, /user_id/],
    [{ ...ok, amount_cad: 0 }, 400, /amount_cad/],
    [{ ...ok, amount_cad: '' }, 400, /amount_cad/],
    [{ ...ok, amount_cad: 'abc' }, 400, /amount_cad/],
    [{ ...ok, amount_cad: 0.001 }, 400, /amount_cad/],
    [{ ...ok, amount_cad: 1e6 }, 400, /too large/],
    [{ ...ok, merchant: '   ' }, 400, /merchant/],
    [{ ...ok, date: '2026-02-30' }, 400, /YYYY-MM-DD/],
    [{ ...ok, date: '2026-11-15' }, 400, /future/],
    [{ ...ok, category_key: '' }, 400, /category_key is required/],
    [{ ...ok, category_key: 'rent' }, 400, /not one of/],
    [{ ...ok, user_id: 'nobody' }, 404, /unknown user/],
  ];
  for (const [input, status, re] of cases) {
    const out = buildManualExpense(input, budgets, mctx);
    assert.equal(out.ok, false, JSON.stringify(input));
    assert.equal(out.status, status, JSON.stringify(input));
    assert.equal(out.code, status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST');
    assert.match(out.message, re, JSON.stringify(input));
  }
});

test('manual expense: inactive budgets are not valid categories', () => {
  const mixed = budgets.map((b) => (b.category_key === 'shopping' ? { ...b, active: 0 } : b));
  const out = buildManualExpense({ user_id: 'test-c', amount_cad: 5, category_key: 'shopping', merchant: 'X' }, mixed, mctx);
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
});

// ---------- the workflow Code nodes embed this file verbatim (spec §19.6) ----------
test('Lane C Code nodes paste the current lib/categorize.mjs verbatim', () => {
  const lib = readFileSync(new URL('lib/categorize.mjs', root), 'utf8');
  const body = lib.slice(0, lib.indexOf('\nexport {')).trim();
  const files = ['03b-manual-expense.json', '03-transaction-sync.json', '02-plaid-connect-sandbox.json'];
  let embedded = 0;
  for (const f of files) {
    const wf = JSON.parse(readFileSync(new URL(`n8n/workflows/${f}`, root), 'utf8'));
    for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
      if (!n.parameters.jsCode.includes('lib/categorize.mjs')) continue;
      assert.ok(n.parameters.jsCode.includes(body), `${f} › ${n.name} is out of date with lib/categorize.mjs`);
      embedded += 1;
    }
  }
  assert.ok(embedded >= 2, 'expected the lib in LO-03b and LO-03');
});
