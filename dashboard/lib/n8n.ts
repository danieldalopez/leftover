// Server-only: every call to n8n goes through here, so N8N_WEBHOOK_KEY never reaches the browser.
// Reads never throw: when n8n is a stub, unreachable or returns an error, the page gets the
// contract fixture instead, plus a Source that the UI shows as a "Mock data" badge.
import { cache } from 'react';
import { connection } from 'next/server';
import { getEnv } from './env';
import type {
  ActionResult,
  Audits,
  Loaded,
  Portfolio,
  Projection,
  Settings,
  SettingsUpdate,
  Source,
  Summary,
} from './types';

import summaryMock from '@/mocks/summary.json';
import auditsMock from '@/mocks/audits.json';
import portfolioMock from '@/mocks/portfolio.json';
import portfolioQueuedMock from '@/mocks/portfolio-queued.json';
import projectionMock from '@/mocks/projection.json';
import settingsMock from '@/mocks/settings.json';

const READ_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 90_000; // "Run audit now" runs LO-04 -> LO-05 -> LO-07

interface N8nResponse {
  status: number;
  json: any;
  text: string;
}

async function callN8n(
  method: 'GET' | 'POST',
  route: string,
  opts: { query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<N8nResponse> {
  const env = getEnv();
  const url = new URL(`${env.baseUrl}/webhook/${route}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      'x-lo-key': env.webhookKey,
      accept: 'application/json',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(opts.timeoutMs ?? READ_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/** Explains a failed n8n response in one line. */
function describeFailure(r: N8nResponse): string {
  const env = getEnv();
  if (r.status === 403) {
    return env.webhookKey ? 'n8n rejected the webhook key (403)' : 'N8N_WEBHOOK_KEY is not set (403)';
  }
  if (r.json?.ok === false && r.json.error) return `${r.json.error.code}: ${r.json.error.message}`;
  if (r.status === 404) return 'route not registered in n8n (is the workflow published?)';
  if (r.json?.message) return `HTTP ${r.status}: ${String(r.json.message).slice(0, 160)}`;
  return `HTTP ${r.status}: ${r.text.slice(0, 160) || 'empty response'}`;
}

function isStub(json: any): boolean {
  return json?.ok === true && json.stub === true;
}

const REQUIRED: Record<string, string[]> = {
  summary: ['week', 'lines', 'totals', 'buffer', 'lifetime', 'portfolio'],
  audits: ['audits', 'totals', 'streaks'],
  portfolio: ['positions', 'orders', 'totals', 'market_open', 'next_open'],
  projection: ['lifetime', 'rates', 'your_choices', 'disclaimer'],
  settings: ['budgets', 'status', 'cushion_rate', 'buffer_target_cad'],
};

async function load<T>(
  name: keyof typeof REQUIRED,
  mock: T,
  request: () => Promise<N8nResponse>,
): Promise<Loaded<T>> {
  await connection(); // always render per request, never at build time
  const env = getEnv();
  if (env.mock) {
    return { data: mock, source: { kind: 'mock', reason: 'mock-mode', detail: 'MOCK=1: serving contract fixtures' } };
  }
  const fallback = (reason: Exclude<Source, { kind: 'live' }>['reason'], detail: string): Loaded<T> => {
    console.warn(`[leftover] ${name}: using mock data (${reason}: ${detail})`);
    return { data: mock, source: { kind: 'mock', reason, detail } };
  };
  try {
    const r = await request();
    if (isStub(r.json)) return fallback('stub', `${r.json.workflow ?? 'LO-08'} is still a stub`);
    if (r.status >= 200 && r.status < 300 && r.json?.ok === true && r.json.data) {
      const missing = REQUIRED[name].filter((k) => !(k in r.json.data));
      if (missing.length) return fallback('shape', `live response is missing ${missing.join(', ')}`);
      return { data: r.json.data as T, source: { kind: 'live' } };
    }
    return fallback('error', describeFailure(r));
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'TimeoutError' ? 'timed out' : err.message) : String(err);
    return fallback('unreachable', `n8n at ${env.baseUrl} unreachable (${msg})`);
  }
}

const userId = () => getEnv().userId;

// React cache(): one n8n call per request even when the layout and the page both need it.
export const getSummary = cache(() =>
  load<Summary>('summary', summaryMock.data as unknown as Summary, () =>
    callN8n('GET', 'lo/api/summary', { query: { user_id: userId() } }),
  ),
);

export const getAudits = cache(() =>
  load<Audits>('audits', auditsMock.data as unknown as Audits, () =>
    callN8n('GET', 'lo/api/audits', { query: { user_id: userId() } }),
  ),
);

/** `variant: 'queued'` only changes which fixture is used as the mock (weekend preview). */
export const getPortfolio = cache((variant: 'default' | 'queued' = 'default') =>
  load<Portfolio>(
    'portfolio',
    (variant === 'queued' ? portfolioQueuedMock.data : portfolioMock.data) as unknown as Portfolio,
    () => callN8n('GET', 'lo/api/portfolio', { query: { user_id: userId() } }),
  ),
);

export const getProjection = cache((rate: string = '0.06') =>
  load<Projection>('projection', projectionMock.data as unknown as Projection, () =>
    callN8n('GET', 'lo/api/projection', { query: { user_id: userId(), rate } }),
  ),
);

/** No GET exists for settings: POST with only user_id applies nothing and returns them (contracts/api.md). */
export const getSettings = cache(() =>
  load<Settings>('settings', settingsMock.data as unknown as Settings, () =>
    callN8n('POST', 'lo/api/settings', { body: { user_id: userId() } }),
  ),
);

export function demoUserId(): string {
  return userId();
}

export function isMockMode(): boolean {
  return getEnv().mock;
}

// ---------------------------------------------------------------- demo bar actions

const money = (n: unknown) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '$?');

interface ActionDef {
  label: string;
  route: string;
  body: (user: string) => Record<string, unknown>;
  describe: (data: any) => string;
}

export const DEMO_PURCHASE = { merchant: 'Banh Mi Saigon', amount_cad: 14.0, category_key: 'eating_out' };

export const ACTIONS: Record<string, ActionDef> = {
  'connect-bank': {
    label: 'Connect sandbox bank',
    route: 'lo/plaid/connect-sandbox',
    body: (u) => ({ user_id: u }),
    describe: (d) =>
      `Connected ${d?.institution_name ?? 'sandbox bank'}${d?.sync ? `, synced ${d.sync.added ?? 0} new` : ''}`,
  },
  'add-purchase': {
    label: 'Add sandbox purchase',
    route: 'lo/demo/add-txn',
    body: (u) => ({ user_id: u, merchant: DEMO_PURCHASE.merchant, amount_cad: DEMO_PURCHASE.amount_cad }),
    describe: (d) =>
      `Added ${money(DEMO_PURCHASE.amount_cad)} at ${DEMO_PURCHASE.merchant}${d?.sync ? `, synced ${d.sync.added ?? 0} new` : ''}`,
  },
  'log-expense': {
    label: 'Log manual expense',
    route: 'lo/expense',
    body: (u) => ({ user_id: u, ...DEMO_PURCHASE }),
    describe: (d) =>
      `Logged ${money(d?.amount_cad ?? DEMO_PURCHASE.amount_cad)} at ${DEMO_PURCHASE.merchant} (${d?.category_key ?? DEMO_PURCHASE.category_key})`,
  },
  sync: {
    label: 'Sync now',
    route: 'lo/sync',
    body: (u) => ({ user_id: u }),
    describe: (d) => `Synced: ${d?.added ?? 0} added, ${d?.modified ?? 0} modified, ${d?.removed ?? 0} removed`,
  },
  audit: {
    label: 'Run audit now',
    route: 'lo/audit/run',
    body: (u) => ({ user_id: u }),
    describe: (d) => {
      const a = Array.isArray(d?.audits) ? d.audits[0] : null;
      if (!a) return 'Audit ran (no audit returned)';
      const orders = Array.isArray(a.invest?.orders) ? a.invest.orders.length : 0;
      const tail = a.status === 'invested' ? `, invested ${money(a.investable_cad)}` : '';
      return `Audit ${a.audit_id}: ${a.status}${tail}${orders ? `, ${orders} orders placed` : ''}`;
    },
  },
  digest: {
    label: 'Send digest',
    route: 'lo/digest/send',
    body: (u) => ({ user_id: u }),
    describe: (d) => (d?.sent_to ? `Digest sent: "${d.subject ?? ''}"` : `Digest built: "${d?.subject ?? ''}" (not sent)`),
  },
  reset: {
    label: 'Reset demo',
    route: 'lo/demo/reset',
    body: () => ({}),
    describe: (d) =>
      `Demo reset: ${d?.transactions_seeded ?? '?'} transactions, ${d?.budgets_seeded ?? '?'} budgets seeded`,
  },
};

export async function runAction(name: string): Promise<ActionResult> {
  const def = ACTIONS[name];
  if (!def) return { ok: false, simulated: false, message: `Unknown action "${name}"` };
  const env = getEnv();
  const body = def.body(env.userId);
  if (name === 'reset' && env.userId !== 'maya') {
    return { ok: false, simulated: false, message: 'Reset only reseeds maya; DEMO_USER_ID is not maya, so it is disabled.' };
  }
  if (env.mock) {
    return { ok: true, simulated: true, message: `Mock mode: would POST /${def.route} ${JSON.stringify(body)}` };
  }
  try {
    const r = await callN8n('POST', def.route, { body, timeoutMs: ACTION_TIMEOUT_MS });
    if (isStub(r.json)) {
      return {
        ok: true,
        simulated: true,
        message: `${r.json.workflow ?? 'That workflow'} is still a stub, nothing changed`,
        offerManual: name === 'add-purchase',
        raw: r.json,
      };
    }
    if (r.status >= 200 && r.status < 300 && r.json?.ok !== false) {
      return { ok: true, simulated: false, message: def.describe(r.json?.data ?? r.json), raw: r.json };
    }
    return {
      ok: false,
      simulated: false,
      message: `Failed: ${describeFailure(r)}`,
      offerManual: name === 'add-purchase',
      raw: r.json ?? r.text,
    };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'TimeoutError' ? 'timed out' : err.message) : String(err);
    return { ok: false, simulated: false, message: `Failed: n8n unreachable (${msg})`, offerManual: name === 'add-purchase' };
  }
}

// ---------------------------------------------------------------- settings save

export function validateSettings(u: SettingsUpdate): string | null {
  if (u.status !== undefined && u.status !== 'active' && u.status !== 'paused') return 'status must be active or paused';
  if (u.cushion_rate !== undefined && !(u.cushion_rate >= 0 && u.cushion_rate <= 1)) return 'cushion rate must be 0–100%';
  if (u.buffer_target !== undefined && !(u.buffer_target >= 0)) return 'buffer target must be 0 or more';
  if (u.absorb_overspend !== undefined && typeof u.absorb_overspend !== 'boolean') return 'absorb_overspend must be true/false';
  for (const b of u.budgets ?? []) {
    if (typeof b.category_key !== 'string' || !(b.weekly_amount >= 0)) return `budget ${b.category_key}: amount must be 0 or more`;
  }
  return null;
}

/** Only the contract's fields, nothing else from the browser. */
export function cleanSettings(input: any): SettingsUpdate {
  const out: SettingsUpdate = {};
  if (input?.status !== undefined) out.status = input.status;
  if (input?.buffer_target !== undefined) out.buffer_target = Number(input.buffer_target);
  if (input?.cushion_rate !== undefined) out.cushion_rate = Number(input.cushion_rate);
  if (input?.absorb_overspend !== undefined) out.absorb_overspend = input.absorb_overspend;
  if (Array.isArray(input?.budgets)) {
    out.budgets = input.budgets.map((b: any) => ({
      category_key: String(b.category_key),
      weekly_amount: Number(b.weekly_amount),
      ...(b.active !== undefined ? { active: Boolean(b.active) } : {}),
    }));
  }
  return out;
}

export async function saveSettings(update: SettingsUpdate): Promise<ActionResult & { settings?: Settings }> {
  const env = getEnv();
  const invalid = validateSettings(update);
  if (invalid) return { ok: false, simulated: false, message: invalid };
  if (env.mock) {
    const base = settingsMock.data as unknown as Settings;
    const settings: Settings = {
      ...base,
      status: update.status ?? base.status,
      buffer_target_cad: update.buffer_target ?? base.buffer_target_cad,
      cushion_rate: update.cushion_rate ?? base.cushion_rate,
      absorb_overspend: update.absorb_overspend ?? base.absorb_overspend,
      budgets: base.budgets.map((b) => {
        const u = update.budgets?.find((x) => x.category_key === b.category_key);
        return u ? { ...b, weekly_amount_cad: u.weekly_amount, active: u.active ?? b.active } : b;
      }),
    };
    return { ok: true, simulated: true, message: 'Mock mode: changes are not saved anywhere', settings };
  }
  try {
    const r = await callN8n('POST', 'lo/api/settings', { body: { user_id: env.userId, ...update }, timeoutMs: 20_000 });
    if (isStub(r.json)) {
      return { ok: true, simulated: true, message: 'Settings API (LO-08) is still a stub: nothing was saved', raw: r.json };
    }
    if (r.status >= 200 && r.status < 300 && r.json?.ok === true) {
      return { ok: true, simulated: false, message: 'Saved', settings: r.json.data as Settings };
    }
    return { ok: false, simulated: false, message: `Save failed: ${describeFailure(r)}`, raw: r.json ?? r.text };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'TimeoutError' ? 'timed out' : err.message) : String(err);
    return { ok: false, simulated: false, message: `Save failed: n8n unreachable (${msg})` };
  }
}
