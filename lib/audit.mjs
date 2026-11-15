// lib/audit.mjs: the weekly audit math for Leftover (spec §6.2–6.8, §10 WF04).
//
// Money is integer cents inside every function here; Data Tables and the API
// use dollars (rounded to cents). Converting once at the edges means the 50%
// cushion split, carries and caps never drift by a fraction of a cent.
//
// Plain functions, no imports, so this pastes straight into the "Compute audits"
// Code node of LO-04: copy everything above the `export` line at the bottom.
// It uses week math from lib/week.mjs (addDays, calendarDate, isYmd,
// weekdayIndex, weekStart), which must be in scope: pasted above it in the Code
// node, or put on globalThis in tests (see lib/audit.test.mjs).

const AUDIT_DEFAULTS = {
  buffer_balance: 0, buffer_target: 100, cushion_rate: 0.5, absorb_overspend: true,
  min_invest: 5, max_weekly_invest: 200, pending_carry: 0, deficit_carry: 0,
};

// ---------- small helpers ----------

function isBlank(value) {
  return value === null || value === undefined || value === '';
}

// Dollars (number or numeric string) to integer cents. Blank counts as 0.
function toCents(dollars) {
  if (isBlank(dollars)) return 0;
  const n = Number(dollars);
  if (!Number.isFinite(n)) throw new Error(`toCents: not a number ${dollars}`);
  return Math.round(n * 100);
}

function fromCents(cents) {
  return cents / 100;
}

// Data Tables store booleans as 1/0; webhooks may send strings. Blank → fallback.
function asBool(value, fallback) {
  if (isBlank(value)) return fallback;
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function auditId(userId, weekStartYmd) {
  return `${userId}-${weekStartYmd}`;
}

// A user's audit settings and running balances, in cents, with spec defaults
// for anything blank.
function userSettings(user) {
  const pick = (key) => (isBlank(user[key]) ? AUDIT_DEFAULTS[key] : user[key]);
  const rate = Math.min(Math.max(Number(pick('cushion_rate')), 0), 1);
  return {
    bufferC: toCents(pick('buffer_balance')),
    targetC: toCents(pick('buffer_target')),
    rate: Number.isFinite(rate) ? rate : AUDIT_DEFAULTS.cushion_rate,
    absorb: asBool(user.absorb_overspend, AUDIT_DEFAULTS.absorb_overspend),
    minC: toCents(pick('min_invest')),
    capC: toCents(pick('max_weekly_invest')),
    pendingC: toCents(pick('pending_carry')),
    deficitC: toCents(pick('deficit_carry')),
    paused: user.status === 'paused',
  };
}

// The user's active budgets, one per category, in table order (row id).
function activeBudgets(budgets, userId) {
  const seen = new Set();
  return budgets
    .filter((b) => b.user_id === userId && asBool(b.active, true) && !isBlank(b.category_key))
    .slice()
    .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
    .filter((b) => (seen.has(b.category_key) ? false : seen.add(b.category_key)));
}

// ---------- §6.2 / §6.3 spend per category ----------

// txn_ids of pending rows that a posted row replaced (its pending_txn_id).
// Only rows that still exist (not removed) supersede anything.
function supersededIds(txns) {
  const ids = new Set();
  for (const t of txns) {
    if (!asBool(t.removed, false) && !isBlank(t.pending_txn_id)) ids.add(String(t.pending_txn_id));
  }
  return ids;
}

// Cents spent per category in the week starting `weekStartYmd` (contracts/data-tables.md
// "What counts toward a week"): not removed, a budget category (so `excluded` and
// inactive categories drop out), date inside the week, not superseded. Pending rows
// count. Refunds are negative, so a category's total can go below zero.
// `txns` must already be one user's rows.
function spendByCategory(txns, categoryKeys, weekStartYmd) {
  const out = {};
  for (const k of categoryKeys) out[k] = 0;
  const superseded = supersededIds(txns);
  const end = addDays(weekStartYmd, 6);
  for (const t of txns) {
    if (asBool(t.removed, false)) continue;
    if (!Object.prototype.hasOwnProperty.call(out, t.category_key)) continue;
    if (superseded.has(String(t.txn_id))) continue;
    const day = calendarDate(t.date);
    if (day < weekStartYmd || day > end) continue;
    out[t.category_key] += toCents(t.amount);
  }
  return out;
}

// ---------- §6.4 under / over per category, no netting ----------

function auditLines(budgets, spentC) {
  return budgets.map((b) => {
    const planned = toCents(b.weekly_amount);
    const actual = spentC[b.category_key] || 0;
    return {
      category_key: b.category_key,
      label: isBlank(b.label) ? b.category_key : b.label,
      planned, actual,
      // Capped at planned (spec §6.4): a refund bigger than the week's spend (negative actual)
      // can bring spend to zero but can't make the leftover exceed the budget.
      under: Math.min(Math.max(planned - actual, 0), planned),
      over: Math.max(actual - planned, 0),
    };
  });
}

function lineTotals(lines) {
  let grossC = 0;
  let overC = 0;
  for (const l of lines) { grossC += l.under; overC += l.over; }
  return { grossC, overC };
}

// Lines as stored in audits.lines_json (dollars).
function linesToJson(lines) {
  return JSON.stringify(lines.map((l) => ({
    category_key: l.category_key, label: l.label,
    planned: fromCents(l.planned), actual: fromCents(l.actual),
    under: fromCents(l.under), over: fromCents(l.over),
  })));
}

function parseLines(linesJson) {
  if (Array.isArray(linesJson)) return linesJson;
  if (isBlank(linesJson)) return [];
  try {
    const parsed = JSON.parse(linesJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// ---------- §6.5 variance cushion ----------

// Overspend drains the buffer first (if absorb is on), then the buffer takes
// `rate` of the gross surplus until it reaches the target. Half cents round up,
// toward the buffer.
function applyCushion({ bufferC, targetC, rate, absorb, grossC, overC }) {
  const afterAbsorbC = absorb ? Math.max(bufferC - overC, 0) : bufferC;
  const roomC = Math.max(targetC - afterAbsorbC, 0);
  const toBufferC = Math.min(Math.round(grossC * rate), roomC);
  return { afterAbsorbC, toBufferC, bufferAfterC: afterAbsorbC + toBufferC };
}

// ---------- §6.6 late-posting true-up ----------

// Re-audit last week with today's transactions, using the budgets it was audited
// with (its lines). If its gross surplus shrank, the difference is late_adj.
// A skipped_paused week moved no money, so it has nothing to true up.
function lateAdjustment(prevAudit, txns) {
  if (!prevAudit || prevAudit.status === 'skipped_paused') return { lateAdjC: 0, oldGrossC: 0, newGrossC: 0 };
  const lines = parseLines(prevAudit.lines_json);
  const spent = spendByCategory(txns, lines.map((l) => l.category_key), calendarDate(prevAudit.week_start));
  let newGrossC = 0;
  // Same cap as auditLines: a net refund can't make a category's leftover exceed its budget.
  for (const l of lines) {
    const planned = toCents(l.planned);
    newGrossC += Math.min(Math.max(planned - spent[l.category_key], 0), planned);
  }
  const oldGrossC = toCents(prevAudit.gross_surplus);
  return { lateAdjC: Math.max(oldGrossC - newGrossC, 0), oldGrossC, newGrossC };
}

// ---------- §6.7 investable amount ----------

// investable = gross - to_buffer - late_adj - deficit_carry + pending_carry, never
// negative (a shortfall becomes the new deficit_carry), capped at max_weekly_invest.
// Below min_invest nothing is invested and the amount becomes pending_carry.
// When it is invested, the old pending_carry is part of it, so the carry resets to 0.
function investableAmount({ grossC, toBufferC, lateAdjC, deficitC, pendingC, capC, minC }) {
  const rawC = grossC - toBufferC - lateAdjC - deficitC + pendingC;
  const deficitAfterC = Math.max(-rawC, 0);
  const cappedC = Math.min(Math.max(rawC, 0), capC);
  if (cappedC < minC) return { rawC, cappedC, investC: 0, pendingAfterC: cappedC, deficitAfterC, carried: true };
  return { rawC, cappedC, investC: cappedC, pendingAfterC: 0, deficitAfterC, carried: false };
}

// ---------- one user, one week ----------

// The audit row for `user` and the week starting `weekStartYmd`, plus the user's
// new balances. `budgets` are the user's active budgets, `txns` the user's
// transactions (at least from last Monday on), `prevAudit` last week's audit row
// or null. A paused user gets a skipped_paused row and no balance change.
function computeAudit({ user, budgets, txns, weekStartYmd, prevAudit, nowIso }) {
  const s = userSettings(user);
  const lines = auditLines(budgets, spendByCategory(txns, budgets.map((b) => b.category_key), weekStartYmd));
  const { grossC, overC } = lineTotals(lines);
  const base = {
    audit_id: auditId(user.user_id, weekStartYmd),
    user_id: user.user_id,
    week_start: weekStartYmd,
    week_end: addDays(weekStartYmd, 6),
    lines_json: linesToJson(lines),
    gross_surplus: fromCents(grossC),
    total_over: fromCents(overC),
  };
  if (s.paused) {
    return {
      audit: {
        ...base, late_adj: 0, to_buffer: 0, buffer_after: fromCents(s.bufferC), investable_cad: 0,
        pending_carry_after: fromCents(s.pendingC), status: 'skipped_paused', created_at: nowIso,
      },
      userUpdate: null,
      cents: { grossC, overC, afterAbsorbC: s.bufferC, toBufferC: 0, bufferAfterC: s.bufferC, lateAdjC: 0, investC: 0 },
    };
  }
  const cushion = applyCushion({ bufferC: s.bufferC, targetC: s.targetC, rate: s.rate, absorb: s.absorb, grossC, overC });
  const late = lateAdjustment(prevAudit, txns);
  const inv = investableAmount({
    grossC, toBufferC: cushion.toBufferC, lateAdjC: late.lateAdjC,
    deficitC: s.deficitC, pendingC: s.pendingC, capC: s.capC, minC: s.minC,
  });
  return {
    audit: {
      ...base,
      late_adj: fromCents(late.lateAdjC),
      to_buffer: fromCents(cushion.toBufferC),
      buffer_after: fromCents(cushion.bufferAfterC),
      investable_cad: fromCents(inv.investC),
      pending_carry_after: fromCents(inv.pendingAfterC),
      status: inv.carried ? 'carried' : 'computed',
      created_at: nowIso,
    },
    userUpdate: {
      user_id: user.user_id,
      buffer_balance: fromCents(cushion.bufferAfterC),
      pending_carry: fromCents(inv.pendingAfterC),
      deficit_carry: fromCents(inv.deficitAfterC),
    },
    cents: { grossC, overC, ...cushion, lateAdjC: late.lateAdjC, ...inv },
  };
}

// The audit as LO-04 returns it (contracts/webhooks.md): money as dollars with
// `_cad` names, `invest` filled in after LO-05 answers.
function auditResponse(audit) {
  const money = (v) => fromCents(toCents(v));
  return {
    audit_id: audit.audit_id,
    user_id: audit.user_id,
    week_start: calendarDate(audit.week_start),
    status: audit.status,
    gross_surplus_cad: money(audit.gross_surplus),
    total_over_cad: money(audit.total_over),
    late_adj_cad: money(audit.late_adj),
    to_buffer_cad: money(audit.to_buffer),
    buffer_after_cad: money(audit.buffer_after),
    investable_cad: money(audit.investable_cad),
    pending_carry_after_cad: money(audit.pending_carry_after),
    invest: null,
  };
}

// What LO-05 answered, for the audit response: its `data` object (status "invested"
// on success), an {ok:false, error} envelope, or {error: "..."} when Execute Workflow failed.
function readInvestResult(result) {
  if (!result || typeof result !== 'object') return { data: null, invested: false };
  if (result.ok === false || typeof result.error === 'string') return { data: result, invested: false };
  const data = result.ok === true && result.data && typeof result.data === 'object' ? result.data : result;
  return { data, invested: data.status === 'invested' };
}

// ---------- the whole run (what the Code node calls) ----------

function badRequest(status, code, message) {
  return { ok: false, status, error: { code, message } };
}

// Decide what LO-04 does for a request. Rows are what the Data Table nodes read
// (users, budgets, transactions from last Monday on, audits from last Monday on).
// Returns an error ({ok:false, status, error}) or {ok:true, week_start, items}
// with one item per user:
//   kind "new"      first audit of this week (or a recompute of a skipped_paused
//                   one, which moved no money): write the row and the user's
//                   balances, invest if asked and computed, send the digest.
//   kind "existing" already audited: write nothing. Audits are final once they
//                   move money; later changes to that week reach the next audit
//                   through the §6.6 true-up. Invested → return it unchanged.
//                   Computed (backfill or a failed invest) + invest → retry LO-05
//                   with the stored amount.
function planAudits({ request, users, budgets, transactions, audits, now }) {
  const req = request || {};
  const invest = isBlank(req.invest) ? true : req.invest;
  if (typeof invest !== 'boolean') return badRequest(400, 'BAD_REQUEST', 'invest must be true or false');

  const currentWeek = weekStart(now);
  let ws = currentWeek;
  if (!isBlank(req.week_start)) {
    if (!isYmd(req.week_start)) return badRequest(400, 'BAD_REQUEST', 'week_start must be YYYY-MM-DD');
    if (weekdayIndex(req.week_start) !== 0) return badRequest(400, 'BAD_REQUEST', `week_start ${req.week_start} is not a Monday`);
    if (req.week_start > currentWeek) return badRequest(400, 'BAD_REQUEST', `week_start ${req.week_start} is in the future`);
    ws = req.week_start;
  }

  let selected;
  const single = !isBlank(req.user_id);
  if (single) {
    if (typeof req.user_id !== 'string') return badRequest(400, 'BAD_REQUEST', 'user_id must be a string');
    const user = users.find((u) => u.user_id === req.user_id);
    if (!user) return badRequest(404, 'NOT_FOUND', `unknown user ${req.user_id}`);
    selected = [user];
  } else {
    const seen = new Set();
    selected = users
      .filter((u) => (u.status === 'active' || u.status === 'paused') && !isBlank(u.user_id))
      .filter((u) => (seen.has(u.user_id) ? false : seen.add(u.user_id)))
      .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
  }

  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const prevWs = addDays(ws, -7);
  const items = [];
  for (const user of selected) {
    const id = auditId(user.user_id, ws);
    const mine = audits.filter((a) => a.user_id === user.user_id);
    const existing = mine.find((a) => a.audit_id === id);

    if (existing && existing.status !== 'skipped_paused') {
      const retry = invest && existing.status === 'computed' && toCents(existing.investable_cad) > 0;
      items.push({
        kind: 'existing', user_id: user.user_id, audit_id: id, week_start: ws,
        write: false, invest: retry, digest: false,
        audit: null, user_update: null,
        investable_cad: fromCents(toCents(existing.investable_cad)),
        response: auditResponse(existing),
      });
      continue;
    }

    // User balances already include any later audited week: auditing an older
    // week now would apply it out of order.
    const later = mine.find((a) => calendarDate(a.week_start) > ws && a.status !== 'skipped_paused');
    if (later) {
      if (single) {
        return badRequest(400, 'BAD_REQUEST',
          `${user.user_id} already has an audit for ${calendarDate(later.week_start)}; audit weeks in order`);
      }
      continue;
    }

    const result = computeAudit({
      user,
      budgets: activeBudgets(budgets, user.user_id),
      txns: transactions.filter((t) => t.user_id === user.user_id),
      weekStartYmd: ws,
      prevAudit: mine.find((a) => a.audit_id === auditId(user.user_id, prevWs)) || null,
      nowIso,
    });
    const status = result.audit.status;
    items.push({
      kind: 'new', user_id: user.user_id, audit_id: id, week_start: ws,
      write: true,
      invest: invest && status === 'computed',
      digest: invest && status !== 'skipped_paused',
      audit: result.audit, user_update: result.userUpdate,
      investable_cad: result.audit.investable_cad,
      response: auditResponse(result.audit),
    });
  }
  return { ok: true, week_start: ws, invest, items };
}

// ---------- inline self-test (spec §10 WF04: throws if the math is wrong) ----------

// Spec §6.8 worked example: groceries 80/62, eating out 50/71, transport 30/22,
// entertainment 40/40; buffer 60 of 100, cushion 50%, absorb on.
// Expect $26 gross, $21 over, buffer 60 → 39 → 52, $13 to buffer, $13 investable.
function auditSelfTest() {
  const ws = '2026-11-09';
  const budgets = [['groceries', 80], ['eating_out', 50], ['transport', 30], ['entertainment', 40]]
    .map(([category_key, weekly_amount], i) => ({ id: i + 1, user_id: 'selftest', category_key, label: category_key, weekly_amount, active: true }));
  const txns = [['groceries', 62], ['eating_out', 71], ['transport', 22], ['entertainment', 40]]
    .map(([category_key, amount], i) => ({ txn_id: `selftest-${i}`, user_id: 'selftest', date: addDays(ws, i), amount, category_key, pending: false, pending_txn_id: '', removed: false }));
  const user = {
    user_id: 'selftest', status: 'active', buffer_balance: 60, buffer_target: 100, cushion_rate: 0.5,
    absorb_overspend: true, min_invest: 5, max_weekly_invest: 200, pending_carry: 0, deficit_carry: 0,
  };
  const r = computeAudit({ user, budgets, txns, weekStartYmd: ws, prevAudit: null, nowIso: '2026-11-15T04:00:00.000Z' });
  const got = [r.audit.gross_surplus, r.audit.total_over, fromCents(r.cents.afterAbsorbC), r.audit.to_buffer,
    r.audit.buffer_after, r.audit.late_adj, r.audit.investable_cad, r.audit.pending_carry_after, r.audit.status];
  const want = [26, 21, 39, 13, 52, 0, 13, 0, 'computed'];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`LO-04 self-test failed (spec §6.8): got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  return true;
}

export {
  AUDIT_DEFAULTS, isBlank, toCents, fromCents, asBool, auditId, userSettings, activeBudgets,
  supersededIds, spendByCategory, auditLines, lineTotals, linesToJson, parseLines,
  applyCushion, lateAdjustment, investableAmount, computeAudit, auditResponse,
  readInvestResult, planAudits, auditSelfTest,
};
