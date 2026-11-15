import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localDate, calendarDate, addDays, weekdayIndex, weekStart, weekEnd,
  previousWeekStart, isInWeek, daysLeft, seedDate,
} from './week.mjs';

test('weekStart of a calendar date is its Monday', () => {
  assert.equal(weekStart('2026-11-09'), '2026-11-09'); // Monday
  assert.equal(weekStart('2026-11-14'), '2026-11-09'); // Saturday
  assert.equal(weekStart('2026-11-15'), '2026-11-09'); // Sunday
  assert.equal(weekStart('2026-11-16'), '2026-11-16'); // next Monday
});

test('weekStart crosses month and year boundaries', () => {
  assert.equal(weekStart('2026-11-01'), '2026-10-26');
  assert.equal(weekStart('2027-01-01'), '2026-12-28');
});

test('Sunday 23:30 Vancouver belongs to that week, not the next', () => {
  // Sun Nov 15 2026 23:30 PST = Mon Nov 16 07:30 UTC
  assert.equal(weekStart('2026-11-16T07:30:00Z'), '2026-11-09');
  assert.equal(weekStart(new Date('2026-11-15T23:30:00-08:00')), '2026-11-09');
  // Mon Nov 16 00:00 PST = 08:00 UTC: new week
  assert.equal(weekStart('2026-11-16T08:00:00Z'), '2026-11-16');
});

test('DST end (Sun Nov 1 2026) week boundaries', () => {
  // Sun Nov 1 23:30 PST (after fall-back) = Nov 2 07:30 UTC
  assert.equal(localDate('2026-11-02T07:30:00Z'), '2026-11-01');
  assert.equal(weekStart('2026-11-02T07:30:00Z'), '2026-10-26');
  // Mon Oct 26 00:30 PDT (before fall-back) = Oct 26 07:30 UTC
  assert.equal(weekStart('2026-10-26T07:30:00Z'), '2026-10-26');
  // Sun Oct 25 23:30 PDT = Oct 26 06:30 UTC: previous week
  assert.equal(weekStart('2026-10-26T06:30:00Z'), '2026-10-19');
  assert.equal(addDays('2026-10-26', 7), '2026-11-02');
});

test('DST start (Sun Mar 8 2026) does not shift days', () => {
  assert.equal(localDate('2026-03-09T06:59:00Z'), '2026-03-08'); // 23:59 PDT Sunday
  assert.equal(weekStart('2026-03-09T06:59:00Z'), '2026-03-02');
  assert.equal(weekStart('2026-03-09T07:00:00Z'), '2026-03-09');
});

test('calendarDate never shifts a date-only value by timezone', () => {
  assert.equal(calendarDate('2026-11-09'), '2026-11-09');
  assert.equal(calendarDate('2026-11-09T00:00:00.000Z'), '2026-11-09');
  assert.equal(calendarDate(new Date('2026-11-09T00:00:00Z')), '2026-11-09');
  // The trap calendarDate avoids: localDate would call this Nov 8 in Vancouver.
  assert.equal(localDate('2026-11-09T00:00:00.000Z'), '2026-11-08');
  assert.throws(() => calendarDate('not a date'));
});

test('weekEnd, previousWeekStart and isInWeek', () => {
  assert.equal(weekEnd('2026-11-09'), '2026-11-15');
  assert.throws(() => weekEnd('2026-11-10'));
  assert.equal(previousWeekStart('2026-11-09'), '2026-11-02');
  assert.equal(isInWeek('2026-11-09', '2026-11-09'), true);
  assert.equal(isInWeek('2026-11-15', '2026-11-09'), true);
  assert.equal(isInWeek('2026-11-16', '2026-11-09'), false);
  assert.equal(isInWeek('2026-11-08', '2026-11-09'), false);
  assert.equal(isInWeek('2026-11-15T00:00:00.000Z', '2026-11-09'), true);
});

test('weekdayIndex is Monday-based', () => {
  assert.equal(weekdayIndex('2026-11-09'), 0);
  assert.equal(weekdayIndex('2026-11-15'), 6);
});

test('daysLeft counts today: Monday 7, Saturday 2, Sunday 1', () => {
  assert.equal(daysLeft(new Date('2026-11-09T12:00:00-08:00')), 7);
  assert.equal(daysLeft(new Date('2026-11-14T12:00:00-08:00')), 2);
  assert.equal(daysLeft(new Date('2026-11-15T20:00:00-08:00')), 1);
});

test('seedDate maps offsets from this Monday and clamps to today', () => {
  const sat = new Date('2026-11-14T10:00:00-08:00');
  assert.equal(seedDate(0, sat), '2026-11-09');
  assert.equal(seedDate(-7, sat), '2026-11-02');
  assert.equal(seedDate(-21, sat), '2026-10-19');
  assert.equal(seedDate(4, sat), '2026-11-13');
  assert.equal(seedDate(6, sat), '2026-11-14'); // Sunday is in the future: clamp
  const mon = new Date('2026-11-09T09:00:00-08:00');
  assert.equal(seedDate(3, mon), '2026-11-09');
});
