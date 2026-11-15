// Deterministic formatting (same output on the server and in the browser, so no hydration
// mismatches): no locale-dependent Intl output except numeric date parts.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TZ = 'America/Vancouver';

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function amount(n: number, decimals = 2): string {
  const v = Math.abs(n).toFixed(decimals);
  const [i, d] = v.split('.');
  return d ? `${group(i)}.${d}` : group(i);
}

/** $1,234.56 (CAD). */
export function cad(n: number | null | undefined, opts: { signed?: boolean; decimals?: number } = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const sign = n < 0 ? '−' : opts.signed && n > 0 ? '+' : '';
  return `${sign}$${amount(n, opts.decimals ?? 2)}`;
}

/** US$1,234.56 */
export function usd(n: number | null | undefined, opts: { signed?: boolean } = {}): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const sign = n < 0 ? '−' : opts.signed && n > 0 ? '+' : '';
  return `${sign}US$${amount(n)}`;
}

/** 0.0084 -> "0.84%" ; 0.5 -> "50%" */
export function pct(n: number, decimals?: number, signed = false): string {
  const v = n * 100;
  const d = decimals ?? (Number.isInteger(Math.round(v * 100) / 100) ? 0 : 2);
  const sign = v < 0 ? '−' : signed && v > 0 ? '+' : '';
  return `${sign}${Math.abs(v).toFixed(d)}%`;
}

export function qty(n: number): string {
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/** "2026-11-09" -> { m, d } without any timezone shift. */
function dateOnly(s: string) {
  const [, m, d] = s.slice(0, 10).split('-').map(Number);
  return { m, d };
}

/** "2026-11-09" -> "Nov 9" */
export function day(s: string): string {
  const { m, d } = dateOnly(s);
  return `${MONTHS[m - 1]} ${d}`;
}

/** "2026-11-09", "2026-11-15" -> "Nov 9 – 15" or "Oct 26 – Nov 1" */
export function weekRange(start: string, end: string): string {
  const a = dateOnly(start);
  const b = dateOnly(end);
  return a.m === b.m ? `${MONTHS[a.m - 1]} ${a.d} – ${b.d}` : `${MONTHS[a.m - 1]} ${a.d} – ${MONTHS[b.m - 1]} ${b.d}`;
}

/** Wall-clock parts of an ISO timestamp in America/Vancouver. */
function vancouver(iso: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const y = get('year');
  const m = get('month');
  const d = get('day');
  return { y, m, d, hour: get('hour') % 24, minute: get('minute'), weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

function clock(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
}

/** ISO -> "Mon, Nov 16, 6:30 am" (Vancouver time) */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const v = vancouver(iso);
  return `${WEEKDAYS[v.weekday].slice(0, 3)}, ${MONTHS[v.m - 1]} ${v.d}, ${clock(v.hour, v.minute)}`;
}

/** ISO -> "Sunday 8:00 pm" */
export function weekdayTime(iso: string): string {
  const v = vancouver(iso);
  return `${WEEKDAYS[v.weekday]} ${clock(v.hour, v.minute)}`;
}

/** ISO -> "Monday" */
export function weekdayName(iso: string): string {
  return WEEKDAYS[vancouver(iso).weekday];
}

export const SLEEVE_LABELS: Record<string, string> = {
  equity_us: 'US equity',
  equity_intl: 'International equity',
  equity_ca: 'Canadian equity',
  bonds: 'Bonds',
  cash: 'Cash',
};

/** Fixed categorical slot per sleeve: color follows the entity (dataviz reference palette). */
export const SLEEVE_SLOT: Record<string, number> = {
  equity_us: 1,
  equity_intl: 2,
  bonds: 3,
  equity_ca: 7,
  cash: 4,
};

export const STATUS_LABELS: Record<string, string> = {
  computed: 'Computed',
  invested: 'Invested',
  carried: 'Carried over',
  skipped_paused: 'Skipped (paused)',
};
