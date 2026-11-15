// lib/week.mjs: week math for Leftover (spec §6.1, §19.5).
// A week runs Monday 00:00 to Sunday 23:59 in America/Vancouver and is
// identified by its Monday, `week_start` ('YYYY-MM-DD').
//
// Two kinds of values, never mix them up:
//   - calendar dates ('YYYY-MM-DD'): transactions.date, audits.week_start.
//     They already ARE a local day. Never run them through a timezone.
//   - instants (Date objects or ISO timestamps with a Z/offset): "now",
//     created_at, filled_at. Convert to a local day with localDate().
//
// Plain functions, no imports, so this pastes straight into an n8n Code node:
// copy everything above the `export` line at the bottom.

const LO_TZ = 'America/Vancouver';
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function isYmd(value) {
  return typeof value === 'string' && YMD_RE.test(value);
}

// Local calendar date ('YYYY-MM-DD') of an instant in `tz`.
function localDate(instant, tz = LO_TZ) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) throw new Error(`localDate: invalid instant ${instant}`);
  const parts = {};
  for (const { type, value } of new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d)) parts[type] = value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Calendar date of a date-only value. Accepts 'YYYY-MM-DD', or a value that a
// date column turned into midnight UTC ('2026-11-09T00:00:00.000Z' or a Date):
// the first 10 characters are the day, with no timezone shift.
function calendarDate(value) {
  if (isYmd(value)) return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && YMD_RE.test(value.slice(0, 10))) return value.slice(0, 10);
  throw new Error(`calendarDate: not a date ${value}`);
}

// Add n days to a calendar date (calendar arithmetic, immune to DST).
function addDays(ymd, n) {
  if (!isYmd(ymd)) throw new Error(`addDays: not YYYY-MM-DD ${ymd}`);
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 0 = Monday … 6 = Sunday.
function weekdayIndex(ymd) {
  if (!isYmd(ymd)) throw new Error(`weekdayIndex: not YYYY-MM-DD ${ymd}`);
  return (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7;
}

// Monday of the week containing `value`. A 'YYYY-MM-DD' string is treated as a
// calendar date; anything else as an instant converted to local time in `tz`.
function weekStart(value = new Date(), tz = LO_TZ) {
  const ymd = isYmd(value) ? value : localDate(value, tz);
  return addDays(ymd, -weekdayIndex(ymd));
}

// Sunday of the week that starts on `weekStartYmd`.
function weekEnd(weekStartYmd) {
  if (weekdayIndex(weekStartYmd) !== 0) throw new Error(`weekEnd: ${weekStartYmd} is not a Monday`);
  return addDays(weekStartYmd, 6);
}

function previousWeekStart(weekStartYmd) {
  if (weekdayIndex(weekStartYmd) !== 0) throw new Error(`previousWeekStart: ${weekStartYmd} is not a Monday`);
  return addDays(weekStartYmd, -7);
}

// True if calendar date `ymd` falls inside the week starting `weekStartYmd`.
function isInWeek(ymd, weekStartYmd) {
  const day = calendarDate(ymd);
  return day >= weekStartYmd && day <= addDays(weekStartYmd, 6);
}

// Days left in the current week including today: Monday = 7 … Sunday = 1.
function daysLeft(now = new Date(), tz = LO_TZ) {
  return 7 - weekdayIndex(localDate(now, tz));
}

// Real date for a seed transaction (spec §19.4): `dayOffset` days from the
// current week's Monday, clamped so seed data never lands in the future.
function seedDate(dayOffset, now = new Date(), tz = LO_TZ) {
  const today = localDate(now, tz);
  const date = addDays(weekStart(today), dayOffset);
  return date > today ? today : date;
}

export {
  LO_TZ, isYmd, localDate, calendarDate, addDays, weekdayIndex, weekStart, weekEnd,
  previousWeekStart, isInWeek, daysLeft, seedDate,
};
