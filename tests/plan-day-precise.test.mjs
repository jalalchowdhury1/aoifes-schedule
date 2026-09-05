// Day-precise projections (2026-09-05, user: "make it day precise").
//
// Before: projectFinish/chainTimeline walked WEEKS from mondayOf(fromDate) and
// returned the finishing week's SUNDAY — every date moved in 7-day steps, the
// whole current week was credited even on a Saturday, and a one-lesson change
// (the DC trip at 0.67 instead of 0.5) could not move the date at all.
//
// Now: the walk prices each calendar day with `dayCapacity` — the SAME per-day
// pricing `expectedSessions` (the pace-gap) has used since 2026-08-31 — starting
// ON fromDate, with sessions already logged that day taken out of day 0, and
// returns the exact day the last remaining session lands.
//
// All expectations below are worked by hand on tiny fixtures — none are copied
// from the implementation's output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectFinish, chainTimeline, dayCapacity, expectedSessions } from '../js/plan/model.js';

const CYC = { anchorMonday: '2026-08-10', dutyStart: '2026-08-11', confirmed: true };
const P0 = { periods: [], parentCycle: CYC, overrides: [], log: [] };
// a daily tb-wb subject, 2 sessions a day, N sessions remaining
const daily = (remaining, extra = {}) => ({
  id: 'sm', type: 'paced', status: 'active',
  rhythm: { kind: 'daily', sessionsPerDay: 2 }, travel: { mode: 'reduced', factor: 0.5 },
  chain: [{ id: 'c1', pattern: 'tb-wb', lessons: 50, tests: 0, done: 100 - remaining }],
  ...extra,
});

test('T1 daily: 7 sessions at 2/day from a Monday finish on the Thursday, not the Sunday', () => {
  // Mon 2, Tue 4, Wed 6, Thu 8 ≥ 7
  assert.deepEqual(projectFinish(daily(7), '2026-09-07', P0), { date: '2026-09-10', days: 4, weeks: 1 });
});

test('T2 daily: the walk starts on fromDate itself — a Saturday start no longer credits Mon–Fri', () => {
  // Sat 2, Sun 4, Mon 6, Tue 8 ≥ 7  (the old walk anchored on Monday Aug 31 and said Sun Sep 6)
  assert.equal(projectFinish(daily(7), '2026-09-05', P0).date, '2026-09-08');
});

test('T3 daily: sessions already logged on fromDate come out of day 0', () => {
  const plan = { ...P0, log: [
    { date: '2026-09-07', activityId: 'sm', status: 'done', curriculum: 'c1', session: 0 },
    { date: '2026-09-07', activityId: 'sm', status: 'done', curriculum: 'c1', session: 1 },
    { date: '2026-09-07', activityId: 'sm', status: 'done', timed: true },         // a ✓ tick, not a session
    { date: '2026-09-07', activityId: 'loe', status: 'done', curriculum: 'x', session: 0 }, // other subject
  ] };
  // Mon 0 (2 − 2 logged), Tue 2, Wed 4, Thu 6, Fri 8 ≥ 7
  assert.equal(projectFinish(daily(7), '2026-09-07', plan).date, '2026-09-11');
  // more logged than the day holds never goes negative
  const heavy = { ...P0, log: Array.from({ length: 6 }, (_, i) =>
    ({ date: '2026-09-07', activityId: 'sm', status: 'done', curriculum: 'c1', session: i })) };
  assert.equal(projectFinish(daily(7), '2026-09-07', heavy).date, '2026-09-11');
});

test('T4 travel: each trip day is worth its own factor — and a per-period factor changes the day', () => {
  const trip = { id: 'p1', start: '2026-09-08', end: '2026-09-10', type: 'travel' };   // Tue–Thu
  // Mon 2, Tue 1 (3), Wed 1 (4), Thu 1 (5), Fri 2 (7), Sat 2 (9) ≥ 8
  assert.equal(projectFinish(daily(8), '2026-09-07', { ...P0, periods: [trip] }).date, '2026-09-12');
  // same trip priced at full speed for this subject: Mon 2, Tue 4, Wed 6, Thu 8 ≥ 8
  const full = { ...trip, factors: { sm: 1 } };
  assert.equal(projectFinish(daily(8), '2026-09-07', { ...P0, periods: [full] }).date, '2026-09-10');
});

test('T5 skip override on a daily day zeroes that day', () => {
  const plan = { ...P0, overrides: [{ id: 'x1', date: '2026-09-08', action: 'skip', activityId: 'sm' }] };
  // Mon 2, Tue 0, Wed 4 ≥ 4
  assert.equal(projectFinish(daily(4), '2026-09-07', plan).date, '2026-09-09');
});

test('T6 weekly rhythm: capacity is spread evenly over the week, so 1/week lands 7 days out', () => {
  const weekly = { id: 'g', type: 'paced', status: 'active', rhythm: { kind: 'weekly', perWeek: 1 },
    travel: { mode: 'pause' }, chain: [{ id: 'c', pattern: 'simple', firstUnit: 1, lastUnit: 10, done: 8 }] };
  // 2 remaining at 1/7 a day: day 7 → 1.0, day 14 → 2.0
  assert.equal(projectFinish(weekly, '2026-09-07', P0).date, '2026-09-20');
});

test('T7 chainTimeline rows land on exact days and the last row equals projectFinish', () => {
  const act = { ...daily(4), chain: [
    { id: 'a', pattern: 'simple', firstUnit: 1, lastUnit: 2, done: 0 },
    { id: 'b', pattern: 'simple', firstUnit: 1, lastUnit: 2, done: 0 },
  ] };
  const rows = chainTimeline(act, '2026-09-07', P0);
  assert.equal(rows[0].finish, '2026-09-07');       // Mon: 2 ≥ 2
  assert.equal(rows[1].finish, '2026-09-08');       // Tue: 4 ≥ 4
  assert.equal(rows.at(-1).finish, projectFinish(act, '2026-09-07', P0).date);
});

test('T8 the fixed-date, count-pending and finished branches are unchanged', () => {
  assert.deepEqual(projectFinish({ ...daily(7), finishOn: '2027-01-13' }, '2026-09-07', P0),
    { date: '2027-01-13', weeks: null, fixed: true });
  assert.equal(projectFinish({ ...daily(7), chain: [{ id: 'w', pattern: 'simple' }] }, '2026-09-07', P0), null);
  assert.deepEqual(projectFinish(daily(0), '2026-09-07', P0), { date: '2026-09-07', weeks: 0, done: true });
});

test('T9 dayCapacity is exactly what expectedSessions charges for that single day', () => {
  const trip = { id: 'p1', start: '2026-09-08', end: '2026-09-10', type: 'travel', factors: { sm: 0.67 } };
  const plan = { ...P0, periods: [trip], overrides: [{ id: 'x1', date: '2026-09-09', action: 'skip', activityId: 'sm' }] };
  for (const d of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-11'])
    assert.equal(dayCapacity(daily(7), d, plan), expectedSessions(daily(7), d, d, plan), d);
  assert.equal(dayCapacity(daily(7), '2026-09-08', plan), 2 * 0.67);
  assert.equal(dayCapacity(daily(7), '2026-09-09', plan), 0);
});

test('T10 weeks is the ceiling of days/7, kept for callers that still read it', () => {
  assert.equal(projectFinish(daily(7), '2026-09-07', P0).weeks, 1);
  assert.equal(projectFinish(daily(19), '2026-09-07', P0).days, 10);   // 10 days × 2 = 20 ≥ 19
  assert.equal(projectFinish(daily(19), '2026-09-07', P0).weeks, 2);
});
