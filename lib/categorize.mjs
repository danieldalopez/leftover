// lib/categorize.mjs: bank data logic for Leftover (spec §6.2, §6.3, §9, §10 WF03, WF03b).
//   - Plaid personal finance category (PFC) → budget category_key via category_map rows
//   - Plaid /transactions/sync pages → rows to upsert / ids to mark removed + the new cursor
//   - pending → posted dedupe (which rows count)
//   - manual expense validation (LO-03b)
//
// Conventions (contracts/data-tables.md):
//   - amount: positive = money out, negative = money in (refund). Plaid uses the same sign.
//   - date: 'YYYY-MM-DD' local calendar date, stored as a string.
//   - category_map lookup: exact (primary, detailed) → (primary, '') → 'other'.
//     Rows with excluded = true use category_key 'excluded'.
//
// Plain functions, no imports, so this pastes straight into an n8n Code node:
// copy everything above the `export` line at the bottom.

const EXCLUDED_KEY = 'excluded';
const FALLBACK_KEY = 'other';
const CAT_YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const USER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Data Tables return booleans as true/false, 1/0 or 'true'/'false'.
function toBool(value) {
  if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

// Dollars rounded to cents. The 1e-6 nudge stops 14.005 * 100 = 1400.4999… rounding down.
function cents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`cents: not a number ${value}`);
  const r = (Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-6)) / 100;
  return Object.is(r, -0) ? 0 : r;
}

// A real calendar date in 'YYYY-MM-DD' (rejects 2026-02-30).
function isCalendarYmd(value) {
  if (typeof value !== 'string' || !CAT_YMD_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function pfcKey(value) {
  return String(value ?? '').trim().toUpperCase();
}

// category_map rows → lookup index. Later rows win on a duplicate key.
function buildCategoryIndex(mapRows) {
  const index = new Map();
  for (const row of mapRows || []) {
    if (!row || !pfcKey(row.plaid_pfc_primary)) continue;
    const key = `${pfcKey(row.plaid_pfc_primary)}|${pfcKey(row.plaid_pfc_detailed)}`;
    const excluded = toBool(row.excluded) || row.category_key === EXCLUDED_KEY;
    index.set(key, { category_key: excluded ? EXCLUDED_KEY : String(row.category_key || FALLBACK_KEY), excluded });
  }
  return index;
}

// PFC primary/detailed → { category_key, excluded, rule }.
// rule: 'detailed' (exact row), 'primary' (row with empty detailed), 'fallback' ('other').
// A transaction with no PFC at all (Plaid fills it ~95% of the time) also falls back to 'other'.
function categorize(primary, detailed, index) {
  const p = pfcKey(primary);
  const d = pfcKey(detailed);
  if (p && d && index.has(`${p}|${d}`)) return { ...index.get(`${p}|${d}`), rule: 'detailed' };
  if (p && index.has(`${p}|`)) return { ...index.get(`${p}|`), rule: 'primary' };
  return { category_key: FALLBACK_KEY, excluded: false, rule: 'fallback' };
}

// One Plaid transaction object → a `transactions` row (contracts/data-tables.md).
// Uses authorized_date (when the purchase happened) over date (when it posted), so a
// late-posting charge lands in the week it was made; LO-04's true-up (§6.6) handles that.
// Throws on a record that can't be stored; mapSyncPages() catches and skips it.
function mapPlaidTransaction(txn, ctx) {
  if (!txn || typeof txn !== 'object') throw new Error('not an object');
  const txnId = String(txn.transaction_id || '').trim();
  if (!txnId) throw new Error('missing transaction_id');
  const date = txn.authorized_date || txn.date;
  if (!isCalendarYmd(date)) throw new Error(`bad date ${date}`);
  const amount = Number(txn.amount);
  if (!Number.isFinite(amount)) throw new Error(`bad amount ${txn.amount}`);
  const pfc = txn.personal_finance_category || {};
  const { category_key } = categorize(pfc.primary, pfc.detailed, ctx.index);
  const merchant = String(txn.merchant_name || txn.name || '').trim() || 'Unknown';
  return {
    txn_id: txnId,
    user_id: ctx.user_id,
    date,
    amount: cents(amount),
    merchant: merchant.slice(0, 120),
    pfc_primary: pfcKey(pfc.primary),
    pfc_detailed: pfcKey(pfc.detailed),
    category_key,
    pending: Boolean(txn.pending),
    pending_txn_id: String(txn.pending_transaction_id || ''),
    source: 'plaid',
    removed: false,
    synced_at: ctx.synced_at,
  };
}

// Fold the pages of one /transactions/sync run (in order) into what to write.
//   ctx: { user_id, index, synced_at, cursor }  (cursor = the one stored before this run)
// Returns:
//   upserts:     rows to upsert by txn_id (one per id, last state wins)
//   removals:    txn_ids to mark removed = true that aren't in `upserts`
//   next_cursor: cursor to store, or null when the run is incomplete (keep the old one)
//   complete:    false if the last page still says has_more (stopped early)
//   not_ready:   true if Plaid hasn't pulled the Item's transactions yet
//   counts:      { added, modified, removed } as reported by Plaid
//   skipped:     [{ transaction_id, reason }] for records that couldn't be mapped
// Pending → posted: the posted row carries pending_txn_id, and Plaid also lists the pending id
// in `removed`. The pending row is marked removed either way, so it never counts twice.
function mapSyncPages(pages, ctx) {
  const rows = new Map();
  const removals = new Set();
  const counts = { added: 0, modified: 0, removed: 0 };
  const skipped = [];
  let cursor = '';
  let last = null;

  const put = (txn) => {
    try {
      const row = mapPlaidTransaction(txn, ctx);
      rows.set(row.txn_id, row);
      removals.delete(row.txn_id);
    } catch (err) {
      skipped.push({ transaction_id: (txn && txn.transaction_id) || null, reason: err.message });
    }
  };
  const drop = (txnId) => {
    if (!txnId) return;
    if (rows.has(txnId)) rows.get(txnId).removed = true;
    else removals.add(txnId);
  };

  for (const page of pages || []) {
    if (!page || typeof page !== 'object') continue;
    last = page;
    const added = page.added || [];
    const modified = page.modified || [];
    const removed = page.removed || [];
    counts.added += added.length;
    counts.modified += modified.length;
    counts.removed += removed.length;
    added.forEach(put);
    modified.forEach(put);
    removed.forEach((r) => drop(r && r.transaction_id));
    if (page.next_cursor) cursor = page.next_cursor;
  }

  // A posted row supersedes its pending row.
  for (const row of [...rows.values()]) {
    if (!row.pending && row.pending_txn_id && row.pending_txn_id !== row.txn_id) drop(row.pending_txn_id);
  }

  const complete = !last || !last.has_more;
  const notReady = Boolean(last) && last.transactions_update_status === 'NOT_READY' && !cursor;
  let nextCursor = cursor || ctx.cursor || '';
  if (!complete) nextCursor = null;
  return {
    upserts: [...rows.values()],
    removals: [...removals],
    next_cursor: nextCursor,
    complete,
    not_ready: notReady,
    counts,
    skipped,
  };
}

// The `transactions` columns (contracts/data-tables.md). Rows read back from a Data Table also
// carry n8n's id/createdAt/updatedAt, which an upsert must not send.
const TXN_COLUMNS = ['txn_id', 'user_id', 'date', 'amount', 'merchant', 'pfc_primary', 'pfc_detailed',
  'category_key', 'pending', 'pending_txn_id', 'source', 'removed', 'synced_at'];

// Everything one sync run must upsert into `transactions`: the mapped rows, plus a full copy of
// each already-stored row that Plaid removed (removed = true). Upserting full rows means one
// write operation and never a half-empty row for an id we've never seen.
//   existingRows: this user's stored Plaid rows (any extra keys are dropped)
function rowsToWrite(syncResult, existingRows, syncedAt) {
  const stored = new Map((existingRows || []).filter((r) => r && r.txn_id).map((r) => [r.txn_id, r]));
  const rows = [...syncResult.upserts];
  for (const id of syncResult.removals) {
    const prev = stored.get(id);
    if (!prev || toBool(prev.removed)) continue;
    const row = {};
    for (const col of TXN_COLUMNS) row[col] = prev[col];
    row.date = String(row.date ?? '').slice(0, 10);
    row.pending = toBool(row.pending);
    row.removed = true;
    row.synced_at = syncedAt;
    rows.push(row);
  }
  return rows;
}

// Plaid base URL from the `config` rows (key plaid_base_url). Sandbox only (spec §0 rule 6 spirit,
// §16.3): anything else is refused so a config typo can never reach production Plaid.
function plaidBaseUrl(configRows) {
  const row = (configRows || []).find((r) => r && r.key === 'plaid_base_url');
  const url = String((row && row.value) || 'https://sandbox.plaid.com').trim().replace(/\/+$/, '');
  if (url !== 'https://sandbox.plaid.com') throw new Error(`plaid_base_url must be https://sandbox.plaid.com, got ${url}`);
  return url;
}

// POST /lo/demo/add-txn → one /sandbox/transactions/create transaction.
//   input: { user_id, merchant, amount_cad, date? }; today: 'YYYY-MM-DD' (Vancouver)
// Plaid takes dates up to today (no future) and up to 730 days back; positive amount = money out.
function buildSandboxTransaction(input, today) {
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  const src = input || {};
  const userId = String(src.user_id ?? '').trim().toLowerCase();
  if (!USER_ID_RE.test(userId)) return fail(400, 'BAD_REQUEST', 'user_id is required (lowercase letters, digits, - or _)');
  const merchant = String(src.merchant ?? '').trim();
  if (!merchant) return fail(400, 'BAD_REQUEST', 'merchant is required');
  const amount = src.amount_cad === '' || src.amount_cad === null || src.amount_cad === undefined ? NaN : Number(src.amount_cad);
  if (!Number.isFinite(amount) || cents(amount) === 0) return fail(400, 'BAD_REQUEST', 'amount_cad must be a non-zero number (negative = refund)');
  if (Math.abs(amount) > 10000) return fail(400, 'BAD_REQUEST', 'amount_cad is too large for a demo purchase');
  const date = String(src.date ?? '').trim().slice(0, 10) || today;
  if (!isCalendarYmd(date)) return fail(400, 'BAD_REQUEST', 'date must be YYYY-MM-DD');
  if (date > today) return fail(400, 'BAD_REQUEST', `date ${date} is in the future (today is ${today})`);
  const oldest = new Date(`${today}T00:00:00Z`);
  oldest.setUTCDate(oldest.getUTCDate() - 730);
  if (date < oldest.toISOString().slice(0, 10)) return fail(400, 'BAD_REQUEST', 'date is more than 730 days ago');
  return {
    ok: true,
    user_id: userId,
    transaction: { date_transacted: date, date_posted: date, amount: cents(amount), description: merchant.slice(0, 120) },
  };
}

// Plaid's error from an n8n HTTP Request error-output item. Returns { code, message }.
// n8n puts Plaid's JSON in different places: error.message = `400 - "<JSON string>"` for a plain
// request, error.error = `<JSON string>` (with error.statusCode) when pagination is on.
function plaidError(item) {
  const e = (item && item.error) || {};
  const candidates = typeof e === 'string' ? [e] : [e.message, e.error, e.description, item && item.details && item.details.message];
  let parsed = null;
  for (const c of candidates) {
    if (parsed || !c) continue;
    try {
      let rest = typeof c === 'string' ? c.replace(/^\d{3}\s*-\s*/, '') : c;
      for (let i = 0; i < 2 && typeof rest === 'string'; i += 1) rest = JSON.parse(rest);
      if (rest && typeof rest === 'object' && rest.error_code) parsed = rest;
    } catch { /* not JSON: try the next place */ }
  }
  const text = typeof e === 'string' ? e : String(e.message || e.error || '');
  if (parsed) {
    return { code: parsed.error_code, message: `Plaid said ${parsed.error_code}: ${parsed.error_message || ''}`.trim() };
  }
  const m = JSON.stringify(item || {}).match(/error_code[^A-Z]*([A-Z_]{4,})/);
  if (m) return { code: m[1], message: `Plaid said ${m[1]}` };
  return { code: 'PLAID_REQUEST_FAILED', message: `Plaid request failed: ${(text || e.name || 'no response').slice(0, 200)}` };
}

// The reply for LO-03 once every bank link has been synced (spec §19.2 envelope).
//   request: { channel: 'api' | 'add-txn' | 'internal' | 'schedule', user_id }
//   results: one per link { user_id, item_id, ok, counts?, not_ready?, error? }
// /lo/sync and internal calls: { users, added, modified, removed }; /lo/demo/add-txn:
// { user_id, sync: {…} }. not_ready: true is added when Plaid hadn't pulled the Item yet.
// Any failed link → 502 UPSTREAM_ERROR (rows from links that worked are still saved).
function syncReply(request, results) {
  const list = results || [];
  const total = { added: 0, modified: 0, removed: 0 };
  for (const r of list) {
    if (!r.ok || !r.counts) continue;
    total.added += r.counts.added;
    total.modified += r.counts.modified;
    total.removed += r.counts.removed;
  }
  const failed = list.filter((r) => !r.ok);
  if (failed.length) {
    const what = failed.map((r) => `${r.user_id}/${r.item_id}: ${r.error || 'failed'}`).join('; ');
    return { status: 502, body: { ok: false, error: { code: 'UPSTREAM_ERROR', message: `Plaid sync failed for ${what}` } } };
  }
  const users = new Set(list.map((r) => r.user_id)).size;
  const notReady = list.some((r) => r.not_ready);
  const sync = notReady ? { ...total, not_ready: true } : total;
  const data = request.channel === 'add-txn' ? { user_id: request.user_id, sync } : { users, ...sync };
  return { status: 200, body: { ok: true, data } };
}

// The rows that count toward spend (contracts/data-tables.md "What counts toward a week"):
// not removed, a budget category (not 'excluded'), and not superseded by a posted row whose
// pending_txn_id points at it. Pending rows count until they post.
function countableTransactions(rows) {
  const live = (rows || []).filter((r) => r && !toBool(r.removed));
  const superseded = new Set(live.map((r) => r.pending_txn_id).filter(Boolean));
  return live.filter((r) => r.category_key && r.category_key !== EXCLUDED_KEY && !superseded.has(r.txn_id));
}

// LO-03b: validate a manual expense against the user's budgets and build the row.
//   input:   { user_id, amount_cad, category_key | category (key or label), merchant, date? }
//   budgets: the user's `budgets` rows
//   ctx:     { today: 'YYYY-MM-DD' (Vancouver), now: ISO timestamp, id_suffix: unique string }
// Returns { ok: true, row, data } or { ok: false, status, code, message } (spec §19.2 codes).
function buildManualExpense(input, budgets, ctx) {
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  const src = input || {};

  const userId = String(src.user_id ?? '').trim().toLowerCase();
  if (!USER_ID_RE.test(userId)) return fail(400, 'BAD_REQUEST', 'user_id is required (lowercase letters, digits, - or _)');

  const rawAmount = typeof src.amount_cad === 'string' ? src.amount_cad.replace(/[$,\s]/g, '') : src.amount_cad;
  const amount = rawAmount === '' || rawAmount === null || rawAmount === undefined ? NaN : Number(rawAmount);
  if (!Number.isFinite(amount) || cents(amount) === 0) return fail(400, 'BAD_REQUEST', 'amount_cad must be a non-zero number (negative = refund)');
  if (Math.abs(amount) > 100000) return fail(400, 'BAD_REQUEST', 'amount_cad is too large');

  const merchant = String(src.merchant ?? '').trim();
  if (!merchant) return fail(400, 'BAD_REQUEST', 'merchant is required');

  const rawDate = String(src.date ?? '').trim().slice(0, 10);
  const date = rawDate || ctx.today;
  if (!isCalendarYmd(date)) return fail(400, 'BAD_REQUEST', 'date must be YYYY-MM-DD');
  if (date > ctx.today) return fail(400, 'BAD_REQUEST', `date ${date} is in the future (today is ${ctx.today})`);

  const mine = (budgets || []).filter((b) => b && b.user_id === userId);
  if (mine.length === 0) return fail(404, 'NOT_FOUND', `unknown user ${userId}: no budgets found`);
  const active = mine.filter((b) => b.active === undefined || b.active === null || b.active === '' || toBool(b.active));

  const wanted = String(src.category_key ?? src.category ?? '').trim();
  if (!wanted) return fail(400, 'BAD_REQUEST', 'category_key is required');
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const budget = active.find((b) => norm(b.category_key) === norm(wanted))
    || active.find((b) => norm(b.label) === norm(wanted));
  if (!budget) {
    const keys = active.map((b) => b.category_key).join(', ');
    return fail(400, 'BAD_REQUEST', `category_key ${wanted} is not one of ${userId}'s budgets (${keys})`);
  }

  const row = {
    txn_id: `manual-${userId}-${ctx.id_suffix}`,
    user_id: userId,
    date,
    amount: cents(amount),
    merchant: merchant.slice(0, 120),
    pfc_primary: '',
    pfc_detailed: '',
    category_key: budget.category_key,
    pending: false,
    pending_txn_id: '',
    source: 'manual',
    removed: false,
    synced_at: ctx.now,
  };
  const data = { txn_id: row.txn_id, user_id: userId, date, amount_cad: row.amount, category_key: row.category_key };
  return { ok: true, row, data };
}

export {
  EXCLUDED_KEY, FALLBACK_KEY, toBool, cents, isCalendarYmd, buildCategoryIndex, categorize,
  mapPlaidTransaction, mapSyncPages, rowsToWrite, plaidBaseUrl, buildSandboxTransaction, plaidError, syncReply,
  countableTransactions, buildManualExpense,
};
