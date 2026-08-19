import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, dayIdx, mondayOf, weeksBetween, daysBetween, isOnWeek, isWorkDay,
  sessionsCount, nextSession, actTotal, actDone, actRemaining,
  dayAway, dayStatus, awayDaysInWeek, effectiveDaysInWeek,
  sanitizePlan, serializePlan,
} from '../js/plan/model.js';

test('date helpers: Mon-first indexing and week math', () => {
  assert.equal(dayIdx('2026-08-16'), 6);            // Sunday
  assert.equal(dayIdx('2026-08-17'), 0);            // Monday
  assert.equal(mondayOf('2026-08-16'), '2026-08-10');
  assert.equal(mondayOf('2026-08-17'), '2026-08-17');
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(weeksBetween('2026-08-17', '2026-08-31'), 2);
  assert.equal(weeksBetween('2026-08-17', '2026-08-23'), 0);
  assert.equal(daysBetween('2026-08-17', '2026-08-18'), 1);
  assert.equal(daysBetween('2026-08-11', '2026-08-25'), 14);
  assert.equal(daysBetween('2026-11-01', '2026-11-02'), 1);   // DST fall-back night
  assert.equal(daysBetween('2027-03-14', '2027-03-15'), 1);   // DST spring-forward
  assert.equal(daysBetween('2026-08-25', '2026-08-11'), -14);
});

test('isOnWeek: anchor week is a work week, alternating', () => {
  const cyc = { anchorMonday: '2026-08-17' };
  assert.equal(isOnWeek(cyc, '2026-08-20'), true);   // anchor week
  assert.equal(isOnWeek(cyc, '2026-08-24'), false);  // next week = home
  assert.equal(isOnWeek(cyc, '2026-08-31'), true);
});

// ── isWorkDay: Charlton stretches run Tue → Mon, every other week ──
test('isWorkDay: dutyStart 2026-08-11 gives work Tue..Mon then 7 home days', () => {
  const cyc = { anchorMonday: '2026-08-24', dutyStart: '2026-08-11' };
  assert.equal(isWorkDay(cyc, '2026-08-11'), true);   // first day of the stretch
  assert.equal(isWorkDay(cyc, '2026-08-17'), true);   // Monday, last day of the stretch
  assert.equal(isWorkDay(cyc, '2026-08-18'), false);  // Tuesday, home stretch starts
  assert.equal(isWorkDay(cyc, '2026-08-24'), false);  // Monday, last home day
  assert.equal(isWorkDay(cyc, '2026-08-25'), true);   // Tuesday, back on duty
  assert.equal(isWorkDay(cyc, '2026-08-31'), true);
  assert.equal(isWorkDay(cyc, '2026-09-01'), false);
  // Dates before dutyStart must not flip the parity (negative modulo guard).
  assert.equal(isWorkDay(cyc, '2026-08-04'), false);  // 7 days earlier = home
  assert.equal(isWorkDay(cyc, '2026-07-28'), true);   // 14 days earlier = work
});

// ── Day-precise time-away periods ───────────────────────────
const DHAKA = { id: 'p1', start: '2027-01-04', end: '2027-02-07', type: 'travel', label: 'Dhaka ✈' };
const PAUSE = { id: 'p2', start: '2027-03-01', end: '2027-03-02', type: 'off' };
const PERIODS = [DHAKA, PAUSE];

test('dayAway: covering period, inclusive on both ends', () => {
  assert.equal(dayAway(PERIODS, '2027-01-03'), null);
  assert.equal(dayAway(PERIODS, '2027-01-04').id, 'p1');   // first day
  assert.equal(dayAway(PERIODS, '2027-01-20').id, 'p1');
  assert.equal(dayAway(PERIODS, '2027-02-07').id, 'p1');   // last day
  assert.equal(dayAway(PERIODS, '2027-02-08'), null);
  assert.equal(dayAway(PERIODS, '2027-03-02').id, 'p2');
  assert.equal(dayAway([], '2027-01-20'), null);
  assert.equal(dayAway(undefined, '2027-01-20'), null);
});

// Overlaps are legal (a work trip inside a longer break) and the sheet only
// warns about them, so the resolution rule has to be pinned down here.
test('dayAway: overlapping periods — off outranks travel, sort order breaks same-type ties', () => {
  const travel = { id: 'p1', start: '2027-01-04', end: '2027-01-10', type: 'travel', label: 'Dhaka' };
  const off = { id: 'p2', start: '2027-01-06', end: '2027-01-07', type: 'off', label: 'Eid' };
  const both = [travel, off];                                // sorted by start
  assert.equal(dayAway(both, '2027-01-05').id, 'p1');        // travel-only day
  assert.equal(dayAway(both, '2027-01-06').id, 'p2');        // overlapped -> off wins
  assert.equal(dayAway(both, '2027-01-07').id, 'p2');
  assert.equal(dayAway(both, '2027-01-08').id, 'p1');        // back to travel-only
  // The rule is about TYPE, not position: an off period listed first still wins,
  // and an off period listed second still wins.
  assert.equal(dayAway([off, travel], '2027-01-06').id, 'p2');
  // Same type overlapping -> the first in sort order (earliest start) wins.
  const t2 = { id: 'p3', start: '2027-01-06', end: '2027-01-12', type: 'travel', label: 'Sylhet' };
  assert.equal(dayAway([travel, t2], '2027-01-08').id, 'p1');
  const o2 = { id: 'p4', start: '2027-01-07', end: '2027-01-09', type: 'off' };
  assert.equal(dayAway([off, o2], '2027-01-07').id, 'p2');
});

test('overlap semantics reach capacity: a reduced daily gets 0 on an off-shadowed travel day', () => {
  const reduced = { travel: { mode: 'reduced', factor: 0.5 } };
  const travel = { id: 'p1', start: '2026-08-17', end: '2026-08-19', type: 'travel' };  // Mon–Wed
  // Singapore Math (reduced) would earn 0.5 on each of the 3 travel days: 5.5.
  assert.equal(effectiveDaysInWeek(reduced, '2026-08-17', [travel]), 5.5);
  // Drop an off day on top of the Tuesday: that day now pauses EVERYTHING, so
  // Singapore loses its half day there — 4 plain days + 2 × 0.5 = 5.
  const off = { id: 'p2', start: '2026-08-18', end: '2026-08-18', type: 'off' };
  assert.equal(effectiveDaysInWeek(reduced, '2026-08-17', [travel, off]), 5);
  // An off period swallowing the whole trip zeroes every one of those days:
  // Mon–Thu off, Fri/Sat/Sun plain = 3.
  const bigOff = { id: 'p3', start: '2026-08-16', end: '2026-08-20', type: 'off' };
  assert.equal(effectiveDaysInWeek(reduced, '2026-08-17', [travel, bigOff]), 3);
  // Total away days are unchanged by the overlap — only WHICH period owns them.
  assert.equal(awayDaysInWeek([travel, off], '2026-08-17'), 3);
});

test('dayStatus: day N of total, type and label', () => {
  assert.deepEqual(dayStatus(PERIODS, '2026-12-31'), { away: false });
  const s = dayStatus(PERIODS, '2027-01-06');
  assert.equal(s.away, true);
  assert.equal(s.type, 'travel');
  assert.equal(s.label, 'Dhaka ✈');
  assert.equal(s.dayN, 3);
  assert.equal(s.total, 35);                              // Jan 4 .. Feb 7 inclusive
  const off = dayStatus(PERIODS, '2027-03-01');
  assert.equal(off.type, 'off');
  assert.equal(off.dayN, 1);
  assert.equal(off.total, 2);
  assert.equal(off.label, '');                            // no label on that period
});

test('awayDaysInWeek / effectiveDaysInWeek: partial weeks count by the day', () => {
  const pause = { travel: { mode: 'pause' } };
  const reduced = { travel: { mode: 'reduced', factor: 0.5 } };
  const cont = { travel: { mode: 'continue' } };
  const monWed = [{ id: 't', start: '2026-08-17', end: '2026-08-19', type: 'travel' }];
  assert.equal(awayDaysInWeek(monWed, '2026-08-17'), 3);
  assert.equal(awayDaysInWeek([], '2026-08-17'), 0);
  assert.equal(awayDaysInWeek([DHAKA], '2027-01-04'), 7);
  assert.equal(effectiveDaysInWeek(pause, '2026-08-17', monWed), 4);
  assert.equal(effectiveDaysInWeek(reduced, '2026-08-17', monWed), 5.5);   // 3×0.5 + 4
  assert.equal(effectiveDaysInWeek(cont, '2026-08-17', monWed), 7);
  const monWedOff = [{ id: 't', start: '2026-08-17', end: '2026-08-19', type: 'off' }];
  assert.equal(effectiveDaysInWeek(reduced, '2026-08-17', monWedOff), 4);  // off beats travel mode
  assert.equal(effectiveDaysInWeek(cont, '2026-08-17', monWedOff), 4);
  assert.equal(effectiveDaysInWeek({}, '2026-08-17', monWed), 4);          // no travel = pause
});

test('session sequences: simple and tb-wb', () => {
  const c = { pattern: 'simple', firstUnit: 81, lastUnit: 120, done: 21, titles: {} };
  assert.equal(sessionsCount(c), 40);
  assert.equal(nextSession(c).label, 'Lesson 102');
  const s = { pattern: 'tb-wb', lessons: 3, tests: 2, done: 0 };
  assert.equal(sessionsCount(s), 8);                 // 3*2 + 2
  assert.equal(nextSession(s).label, 'Lesson 1 · textbook');
  s.done = 1;
  assert.equal(nextSession(s).label, 'Lesson 1 · workbook');
  s.done = 6;
  assert.equal(nextSession(s).label, 'Test 1');
  s.done = 8;
  assert.equal(nextSession(s), null);
});

test('chain totals: LoE C at lesson 101 done 2026-08-16', () => {
  const act = { chain: [
    { pattern: 'simple', firstUnit: 81, lastUnit: 120, done: 21 },
    { pattern: 'simple', firstUnit: 121, lastUnit: 140, done: 0 },
  ] };
  assert.equal(actTotal(act), 60);
  assert.equal(actDone(act), 21);
  assert.equal(actRemaining(act), 39);               // 19 left in C + 20 in D
});

test('sanitizePlan: drops junk, keeps unknown fields, defaults everything', () => {
  const raw = {
    version: 1, futureField: 'keep-me',
    year: { label: 'x', start: '2026-08-17', end: '2027-08-31' },
    periods: [{ id: 'p1', start: '2027-01-04', end: '2027-02-07', type: 'travel' },
              { id: 'bad', start: 'nope', end: '2027-02-07', type: 'travel' }],
    activities: [
      { id: 'ok', type: 'ongoing' },
      { type: 'paced' },                              // no id -> dropped
      null,
    ],
    log: [
      { date: '2026-08-16', activityId: 'ok', status: 'done' },
      { status: 'done' },                             // no date -> dropped
    ],
    overrides: 'garbage',
  };
  const p = sanitizePlan(raw);
  assert.equal(p.futureField, 'keep-me');
  assert.equal(p.periods.length, 1);
  assert.equal(p.activities.length, 1);
  assert.equal(p.log.length, 1);
  assert.deepEqual(p.overrides, []);
  const empty = sanitizePlan(null);
  assert.equal(empty.version, 1);
  assert.ok(Array.isArray(empty.activities));
  assert.deepEqual(empty.periods, []);
  assert.equal(empty.parentCycle.dutyStart, '2026-08-11');
});

test('sanitizePlan: periods validated (id, ISO dates, start<=end, known type) and sorted', () => {
  const p = sanitizePlan({ periods: [
    { id: 'b', start: '2027-03-01', end: '2027-03-02', type: 'off', label: 'Rest' },
    { id: 'a', start: '2027-01-04', end: '2027-02-07', type: 'travel', label: 'Dhaka' },
    { id: '', start: '2027-04-01', end: '2027-04-02', type: 'travel' },      // no id
    { id: 'c', start: '2027-05-02', end: '2027-05-01', type: 'travel' },     // end < start
    { id: 'd', start: '2027-06-01', end: 'zzz', type: 'travel' },            // bad ISO
    { id: 'e', start: '2027-07-01', end: '2027-07-02', type: 'light' },      // type gone
    { id: 'f', start: '2027-08-01', end: '2027-08-02' },                     // no type
    'garbage', null,
  ] });
  assert.deepEqual(p.periods.map(x => x.id), ['a', 'b']);                    // sorted by start
  assert.deepEqual(p.periods[0], { id: 'a', start: '2027-01-04', end: '2027-02-07',
                                   type: 'travel', label: 'Dhaka' });
  assert.equal(p.periods[1].label, 'Rest');
  assert.deepEqual(sanitizePlan({ periods: 'nope' }).periods, []);
});

test('sanitizePlan: legacy weeks map migrates to 7-day periods and the key is gone', () => {
  const p = sanitizePlan({ weeks: {
    '2027-01-11': { type: 'travel', label: 'Dhaka' },
    '2027-01-04': { type: 'travel', label: 'Dhaka' },
    '2027-02-15': { type: 'off' },
    '2026-10-05': { type: 'light' },                 // light is REMOVED -> dropped
    '2026-11-02': { type: 'teaching' },              // normal week -> nothing to record
    'zzz': { type: 'travel' },                       // bad key -> dropped
  } });
  assert.equal(p.periods.length, 3);
  assert.deepEqual(p.periods.map(x => x.start), ['2027-01-04', '2027-01-11', '2027-02-15']);
  assert.deepEqual(p.periods[0], { id: 'w-2027-01-04', start: '2027-01-04',
                                   end: '2027-01-10', type: 'travel', label: 'Dhaka' });
  assert.equal(p.periods[2].type, 'off');
  assert.equal(p.periods[2].end, '2027-02-21');      // monday + 6
  assert.equal(Object.keys(p).includes('weeks'), false);
  assert.equal('weeks' in JSON.parse(serializePlan(p)), false);
  // Re-sanitizing is idempotent (no duplicate periods from a second migration).
  assert.equal(sanitizePlan(JSON.parse(serializePlan(p))).periods.length, 3);
});

test('sanitizePlan output has no weeks property at all — own or shimmed (Task C)', () => {
  // The Task A/B inert-empty-map shim (kept alive for year.js/today.js until
  // they were rewritten) is gone: `weeks` must not exist on the plan by any
  // means (own enumerable key, non-enumerable shim, or 'in' lookup).
  const p = sanitizePlan({ weeks: { '2027-01-04': { type: 'travel', label: 'Dhaka' } } });
  assert.equal('weeks' in p, false);
  assert.equal(Object.prototype.hasOwnProperty.call(p, 'weeks'), false);
  assert.equal(p.weeks, undefined);
});

test('sanitizePlan: parentCycle.dutyStart ISO-validated with a 2026-08-11 default', () => {
  assert.equal(sanitizePlan({ parentCycle: { anchorMonday: '2026-08-24', dutyStart: '2026-09-08' } })
    .parentCycle.dutyStart, '2026-09-08');
  assert.equal(sanitizePlan({ parentCycle: { anchorMonday: '2026-08-24', dutyStart: 'zzz' } })
    .parentCycle.dutyStart, '2026-08-11');
  const kept = sanitizePlan({ parentCycle: { pattern: '7on7off', anchorMonday: '2026-08-24', confirmed: true } });
  assert.equal(kept.parentCycle.anchorMonday, '2026-08-24');
  assert.equal(kept.parentCycle.confirmed, true);
  assert.equal(kept.parentCycle.dutyStart, '2026-08-11');
});

import {
  weekCapacity, projectFinish, requiredPerCycle, cycleBounds, cycleStats,
  targetStats, tripImpact, findClashes, freeSlots, doneOn,
} from '../js/plan/model.js';

const LOE = {
  id: 'loe', name: 'Logic of English', type: 'paced', status: 'active',
  rhythm: { kind: 'cycle', perOnWeek: 1, perOffWeek: 2.5 },
  travel: { mode: 'pause' },
  goal: { finishBy: '2027-08-31' },
  chain: [
    { id: 'loe-c', pattern: 'simple', firstUnit: 81, lastUnit: 120, done: 21 },
    { id: 'loe-d', pattern: 'simple', firstUnit: 121, lastUnit: 140, done: 0 },
  ],
};
const SM = {
  id: 'singapore', name: 'Singapore Math', type: 'paced', status: 'active',
  rhythm: { kind: 'daily' }, travel: { mode: 'reduced', factor: 0.5 },
  chain: [{ id: 'dm3', pattern: 'tb-wb', lessons: 60, tests: 14, done: 0 }],
};
const CYC = { anchorMonday: '2026-08-17', dutyStart: '2026-08-11', confirmed: false };
// The old 5-week JAN_TRIP weeks-map fixture, as one day-precise period.
const JAN_TRIP = [{ id: 'p1', start: '2027-01-04', end: '2027-02-07', type: 'travel', label: 'Dhaka' }];

test('weekCapacity: rhythms × away days', () => {
  assert.equal(weekCapacity(SM, '2026-08-17', [], CYC), 7);               // daily, no trip
  assert.equal(weekCapacity(SM, '2027-01-04', JAN_TRIP, CYC), 3.5);       // daily reduced, all 7 away
  assert.equal(weekCapacity(LOE, '2026-08-17', [], CYC), 1);              // cycle, work week
  assert.equal(weekCapacity(LOE, '2026-08-24', [], CYC), 2.5);            // cycle, home week
  assert.equal(weekCapacity(LOE, '2027-01-04', JAN_TRIP, CYC), 0);        // pause on travel
  const geo = { rhythm: { kind: 'weekly', perWeek: 1 }, travel: { mode: 'pause' } };
  assert.equal(weekCapacity(geo, '2026-08-17', [], CYC), 1);
  assert.equal(weekCapacity(geo, '2026-08-17',
    [{ id: 'o', start: '2026-08-17', end: '2026-08-23', type: 'off' }], CYC), 0);
  // Malformed periods (not an array) are read as "no time away" — dayAway's
  // own defensive guard, not a legacy-weeks-map shim (that's gone; every
  // caller in the app passes plan.periods, a real array).
  assert.equal(weekCapacity(SM, '2026-08-17', {}, CYC), 7);
  assert.equal(weekCapacity(SM, '2026-08-17', undefined, CYC), 7);
});

test('weekCapacity: a 3-day trip inside a home week scales the cycle base by 4/7', () => {
  const trip = [{ id: 'p9', start: '2026-08-26', end: '2026-08-28', type: 'travel' }];
  const cap = weekCapacity(LOE, '2026-08-24', trip, CYC);                 // home week, LoE pauses
  assert.ok(Math.abs(cap - 2.5 * 4 / 7) < 0.01, String(cap));
  const work = weekCapacity(LOE, '2026-08-17',
    [{ id: 'p9', start: '2026-08-19', end: '2026-08-21', type: 'travel' }], CYC);
  assert.ok(Math.abs(work - 1 * 4 / 7) < 0.01, String(work));
});

test('weekCapacity: Singapore (daily, reduced) Mon-Wed away = 5.5; the same days off = 4', () => {
  const travel = [{ id: 'p9', start: '2026-08-17', end: '2026-08-19', type: 'travel' }];
  assert.equal(weekCapacity(SM, '2026-08-17', travel, CYC), 5.5);         // 3×0.5 + 4
  const off = [{ id: 'p9', start: '2026-08-17', end: '2026-08-19', type: 'off' }];
  assert.equal(weekCapacity(SM, '2026-08-17', off, CYC), 4);
});

test('LoE projection: C ~Nov 2026, C+D Feb-Mar 2027 with the Jan trip, before goal', () => {
  // 39 sessions left at 3.5/cycle from 2026-08-17 with a 35-day January travel pause.
  const fin = projectFinish(LOE, '2026-08-17', { periods: JAN_TRIP, parentCycle: CYC });
  assert.ok(fin.date >= '2027-02-01' && fin.date <= '2027-03-31', fin.date);
  assert.ok(fin.date < LOE.goal.finishBy);
  // C alone (clone with D emptied) lands around Nov 2026.
  const cOnly = { ...LOE, chain: [LOE.chain[0]] };
  const finC = projectFinish(cOnly, '2026-08-17', { periods: [], parentCycle: CYC });
  assert.ok(finC.date >= '2026-10-15' && finC.date <= '2026-11-30', finC.date);
  // The trip pushes the finish out.
  const noTrip = projectFinish(LOE, '2026-08-17', { periods: [], parentCycle: CYC });
  assert.ok(fin.date > noTrip.date);
});

test('LoE minimum pace to hit the goal is about 2 per cycle', () => {
  const need = requiredPerCycle(LOE, '2026-08-17', { periods: JAN_TRIP, parentCycle: CYC });
  assert.ok(need > 1 && need < 2.5, String(need));
});

test('unknown counts (waiting for books) -> no projection', () => {
  const waiting = { ...SM, chain: [{ pattern: 'tb-wb', lessons: 0, tests: 0, done: 0 }] };
  assert.equal(projectFinish(waiting, '2026-08-17', { periods: [], parentCycle: CYC }), null);
});

test('cycleStats: one work-week lesson is on pace; targets 3-4', () => {
  const log = [{ date: '2026-08-20', activityId: 'loe', status: 'done' }];
  const st = cycleStats(LOE, '2026-08-22', CYC, log);   // Sat of anchor (work) week
  assert.equal(st.done, 1);
  assert.equal(st.targetMin, 3);
  assert.equal(st.targetMax, 4);
  assert.equal(st.behind, false);                        // cycle not over
  const bounds = cycleBounds(CYC, '2026-08-30');         // Sunday of 2nd week
  assert.equal(bounds.start, '2026-08-17');
  const st2 = cycleStats(LOE, '2026-08-31', CYC, log);   // new cycle started, prev had 1<3
  assert.equal(st2.prevBehind, true);
});

test('targetStats: JJ 3 done at ~week 11 of 48 teaching weeks, target 20 -> behind', () => {
  const jj = { id: 'jj', type: 'target', status: 'active', target: 20 };
  const plan = { year: { start: '2026-09-01', end: '2027-08-31' }, periods: JAN_TRIP, parentCycle: CYC };
  const log = Array.from({ length: 3 }, (_, i) =>
    ({ date: addDays('2026-09-05', i * 14), activityId: 'jj', status: 'done' }));
  const st = targetStats(jj, plan, log, '2026-11-10');
  assert.equal(st.done, 3);
  assert.ok(st.expected >= 4 && st.expected <= 5, String(st.expected)); // 20 * 11/48
  assert.ok(st.behind >= 1);
});

test('targetStats: a teaching week needs >=4 plain school days', () => {
  const jj = { id: 'jj', type: 'target', status: 'active', target: 10 };
  const year = { start: '2026-08-17', end: '2026-09-13' };               // 4 weeks
  const none = targetStats(jj, { year, periods: [], parentCycle: CYC }, [], '2026-09-13');
  const three = targetStats(jj, { year, parentCycle: CYC,                // 3 away days -> still teaching
    periods: [{ id: 'a', start: '2026-08-17', end: '2026-08-19', type: 'travel' }] }, [], '2026-09-13');
  const four = targetStats(jj, { year, parentCycle: CYC,                 // 4 away days -> not teaching
    periods: [{ id: 'a', start: '2026-08-17', end: '2026-08-20', type: 'travel' }] }, [], '2026-09-13');
  assert.equal(none.expected, 10);                                       // all 4 weeks elapsed
  assert.equal(three.expected, 10);
  assert.equal(four.expected, 10);                                       // 3 of 3 weeks elapsed
  // The week itself is what changed: expected is a ratio, so compare mid-year instead.
  const midNone = targetStats(jj, { year, periods: [], parentCycle: CYC }, [], '2026-08-17');
  const midFour = targetStats(jj, { year, parentCycle: CYC,
    periods: [{ id: 'a', start: '2026-08-17', end: '2026-08-20', type: 'travel' }] }, [], '2026-08-17');
  assert.ok(midFour.expected < midNone.expected, `${midFour.expected} < ${midNone.expected}`);
});

// ── tripImpact: live preview for the time-away sheet ─────────
const IMPACT_PLAN = {
  year: { start: '2026-08-17', end: '2027-08-31' },
  parentCycle: CYC, periods: [], log: [],
  activities: [LOE, { ...SM, status: 'planned' },
    { id: 'waiting', name: 'Books pending', type: 'paced', status: 'active',
      rhythm: { kind: 'weekly', perWeek: 1 }, chain: [] }],
};

test('tripImpact: adding the Jan trip moves the LoE finish later but keeps it before the goal', () => {
  const rows = tripImpact(IMPACT_PLAN, JAN_TRIP[0], '2026-08-17');
  assert.deepEqual(rows.map(r => r.id), ['loe']);      // planned + unknown-count rows skipped
  assert.equal(rows[0].name, 'Logic of English');
  const { before, after } = rows[0];
  assert.ok(after > before, `${after} > ${before}`);
  assert.ok(after < LOE.goal.finishBy);
  assert.equal(before, projectFinish(LOE, '2026-08-17', { ...IMPACT_PLAN, periods: [] }).date);
  assert.equal(after, projectFinish(LOE, '2026-08-17', { ...IMPACT_PLAN, periods: JAN_TRIP }).date);
  assert.deepEqual(IMPACT_PLAN.periods, []);           // never mutates the plan
});

test('tripImpact: an edit draft REPLACES the period it carries an id for, it does not stack', () => {
  const p = { ...IMPACT_PLAN, periods: JAN_TRIP };
  const shorter = { id: 'p1', start: '2027-01-04', end: '2027-01-10', type: 'travel', label: 'Dhaka' };
  const rows = tripImpact(p, shorter, '2026-08-17');
  assert.equal(rows[0].before, projectFinish(LOE, '2026-08-17', { ...p, periods: JAN_TRIP }).date);
  assert.equal(rows[0].after, projectFinish(LOE, '2026-08-17', { ...p, periods: [shorter] }).date);
  assert.ok(rows[0].after < rows[0].before, `${rows[0].after} < ${rows[0].before}`);
  assert.equal(p.periods.length, 1);                   // no stacking, no mutation
  // A draft with a NEW id adds on top of the existing trip (before the finish).
  const extra = { id: 'p2', start: '2026-10-05', end: '2026-10-18', type: 'off' };
  const rows2 = tripImpact(p, extra, '2026-08-17');
  assert.ok(rows2[0].after > rows2[0].before, `${rows2[0].after} > ${rows2[0].before}`);
  assert.equal(p.periods.length, 1);
  // An id-less draft is a plain add (the sheet has no id until the trip is saved).
  const fresh = tripImpact({ ...p, periods: [] }, { start: '2026-10-05', end: '2026-10-18', type: 'off' },
    '2026-08-17');
  assert.ok(fresh[0].after > fresh[0].before, `${fresh[0].after} > ${fresh[0].before}`);
  // A half-filled draft (no dates yet) is a no-op preview.
  const rows3 = tripImpact(p, { start: '2027-04-05' }, '2026-08-17');
  assert.equal(rows3[0].after, rows3[0].before);
});

test('clash: Science Tue 2:30-3:30 overlaps Hala Tue 2-3; suggestions avoid busy slots', () => {
  const events = [
    { id: 'e1', cat: 'hala', day: 1, start: 14, end: 15 },
    { id: 'e2', cat: 'ruhamah', day: 1, start: 11, end: 12 },
  ];
  const hits = findClashes(events, { day: 1, start: 14.5, end: 15.5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'e1');
  const free = freeSlots(events, 1, 1);
  assert.ok(free.length > 0);
  for (const s of free) assert.equal(findClashes(events, { day: 1, start: s, end: s + 1 }).length, 0);
});

test('doneOn finds a done log entry for a date', () => {
  const log = [{ date: '2026-08-16', activityId: 'loe', status: 'done' }];
  assert.equal(doneOn(log, 'loe', '2026-08-16'), true);
  assert.equal(doneOn(log, 'loe', '2026-08-15'), false);
});

// ── "This week" helpers (Today card) ─────────────────────────
import { teachingWeekNumber, dailyStreak, MAX_BRIDGE } from '../js/plan/model.js';

const YR = { label: 'y', start: '2026-08-17', end: '2027-08-31' };   // 08-17 is a Monday
const twPlan = periods => ({ year: YR, periods });

test('teachingWeekNumber: 1 at year.start, and any day of that week', () => {
  const p = twPlan([]);
  assert.equal(teachingWeekNumber(p, '2026-08-17'), 1);
  assert.equal(teachingWeekNumber(p, '2026-08-21'), 1);          // Friday of week 1
  assert.equal(teachingWeekNumber(p, '2026-08-24'), 2);
  assert.equal(teachingWeekNumber(p, '2026-09-07'), 4);
});

test('teachingWeekNumber: a majority-away week returns null AND does not advance the count', () => {
  const trip = twPlan([{ id: 'p1', start: '2026-08-24', end: '2026-08-30', type: 'travel' }]);
  assert.equal(teachingWeekNumber(trip, '2026-08-26'), null);     // the trip week itself
  assert.equal(teachingWeekNumber(trip, '2026-08-31'), 2);        // resumes at 2, not 3
  assert.equal(teachingWeekNumber(trip, '2026-09-07'), 3);
});

test('teachingWeekNumber: 3 away days still teach, 4 do not (same rule as targetStats)', () => {
  const three = twPlan([{ id: 'p1', start: '2026-08-24', end: '2026-08-26', type: 'travel' }]);
  assert.equal(teachingWeekNumber(three, '2026-08-24'), 2);       // 4 school days left
  assert.equal(teachingWeekNumber(three, '2026-08-31'), 3);
  const four = twPlan([{ id: 'p1', start: '2026-08-24', end: '2026-08-27', type: 'off' }]);
  assert.equal(teachingWeekNumber(four, '2026-08-24'), null);
  assert.equal(teachingWeekNumber(four, '2026-08-31'), 2);        // the away week is skipped
});

test('teachingWeekNumber: null before the year starts, past year.end, and on a malformed plan', () => {
  assert.equal(teachingWeekNumber(twPlan([]), '2026-08-10'), null);
  assert.equal(teachingWeekNumber(twPlan([]), '2027-08-31'), 55);      // last day of the year
  assert.equal(teachingWeekNumber(twPlan([]), '2027-09-01'), null);    // one day past it
  assert.equal(teachingWeekNumber({ year: { start: 'nope' }, periods: [] }, '2026-08-17'), null);
  assert.equal(teachingWeekNumber(null, '2026-08-17'), null);
  assert.equal(teachingWeekNumber(twPlan([]), 'nope'), null);
});

const doneDays = (dates, id = 'sm') => dates.map(date => ({ date, activityId: id, status: 'done' }));

test('dailyStreak: a plain run counts back from today, only this activity, only done', () => {
  const log = doneDays(['2026-08-15', '2026-08-16', '2026-08-17']);
  assert.equal(dailyStreak(log, 'sm', [], '2026-08-17'), 3);
  assert.equal(dailyStreak(log, 'loe', [], '2026-08-17'), 0);     // another activity's run
  const partial = [...log, { date: '2026-08-18', activityId: 'sm', status: 'partial' }];
  assert.equal(dailyStreak(partial, 'sm', [], '2026-08-18'), 3);  // 'partial' is not 'done'
});

test('dailyStreak: an unchecked morning keeps yesterday’s streak; a plain missed day ends it', () => {
  const log = doneDays(['2026-08-15', '2026-08-16', '2026-08-17']);
  assert.equal(dailyStreak(log, 'sm', [], '2026-08-18'), 3);      // today not ticked YET
  assert.equal(dailyStreak(log, 'sm', [], '2026-08-19'), 0);      // a whole day went by
});

test('dailyStreak: an away day with no entry bridges the run; the same gap at home breaks it', () => {
  const log = doneDays(['2026-08-14', '2026-08-15', '2026-08-17', '2026-08-18']);
  const away = [{ id: 'p1', start: '2026-08-16', end: '2026-08-16', type: 'travel' }];
  assert.equal(dailyStreak(log, 'sm', away, '2026-08-18'), 4);    // travel day bridged
  assert.equal(dailyStreak(log, 'sm', [], '2026-08-18'), 2);      // no trip -> broken
});

test('dailyStreak: empty or malformed log is 0', () => {
  assert.equal(dailyStreak([], 'sm', [], '2026-08-18'), 0);
  assert.equal(dailyStreak(null, 'sm', [], '2026-08-18'), 0);
  assert.equal(dailyStreak([{ activityId: 'sm', status: 'done' }], 'sm', [], '2026-08-18'), 0);
});

// ── Bounded away-day bridge (review correction) ──────────────
// An away day with nothing logged keeps a streak alive, but only for
// MAX_BRIDGE consecutive days: a 5-week trip with zero entries must not still
// be advertising the run the family earned before the flight.
const range = (from, n, id = 'sm') =>
  Array.from({ length: n }, (_, i) => ({ date: addDays(from, i), activityId: id, status: 'done' }));

const TRIP34 = [{ id: 'p1', start: '2026-09-07', end: '2026-10-10', type: 'travel', label: 'Dhaka' }];
const RUN12 = range('2026-08-26', 12);                 // Aug 26 – Sep 6, ends the day before

test('dailyStreak: MAX_BRIDGE is 2 — a 34-day trip with no entries drops the run by day 3', () => {
  assert.equal(MAX_BRIDGE, 2);
  assert.equal(dailyStreak(RUN12, 'sm', TRIP34, '2026-09-06'), 12);   // last day before the trip
  assert.equal(dailyStreak(RUN12, 'sm', TRIP34, '2026-09-07'), 12);   // trip day 1
  assert.equal(dailyStreak(RUN12, 'sm', TRIP34, '2026-09-08'), 12);   // day 2 — bridge spent
  assert.equal(dailyStreak(RUN12, 'sm', TRIP34, '2026-09-09'), 0);    // day 3 — bridge exceeded
  assert.equal(dailyStreak(RUN12, 'sm', TRIP34, '2026-10-10'), 0);    // and stays gone
});

test('dailyStreak: every-other-day work DURING a trip keeps the run counting', () => {
  const log = ['2026-09-07', '2026-09-09', '2026-09-11', '2026-09-13']
    .map(date => ({ date, activityId: 'sm', status: 'done' }));
  assert.equal(dailyStreak(log, 'sm', TRIP34, '2026-09-13'), 4);      // one-day gaps bridge
  assert.equal(dailyStreak(log, 'sm', TRIP34, '2026-09-14'), 4);      // morning after, unticked
  assert.equal(dailyStreak(log, 'sm', TRIP34, '2026-09-15'), 4);      // two missed away days
  assert.equal(dailyStreak(log, 'sm', TRIP34, '2026-09-16'), 0);      // three -> gone
});

test('dailyStreak: a plain missed day after the trip breaks the run immediately', () => {
  const log = [...range('2026-10-08', 3)];             // Oct 8, 9, 10 (trip ends Oct 10)
  assert.equal(dailyStreak(log, 'sm', TRIP34, '2026-10-11'), 3);      // morning grace at home
  assert.equal(dailyStreak(log, 'sm', TRIP34, '2026-10-12'), 0);      // a whole home day missed
});

test('dailyStreak: a 20-day off block with nothing logged is 0, same as travel', () => {
  const off = [{ id: 'p9', start: '2026-11-02', end: '2026-11-21', type: 'off' }];
  const run = range('2026-10-24', 10);                 // Oct 24 – Nov 2 ... ends on day 1 of the block
  assert.equal(dailyStreak(run, 'sm', off, '2026-11-02'), 10);
  assert.equal(dailyStreak(run, 'sm', off, '2026-11-04'), 10);        // bridge holds 2 days
  assert.equal(dailyStreak(run, 'sm', off, '2026-11-05'), 0);
  assert.equal(dailyStreak(run, 'sm', off, '2026-11-21'), 0);
});

// ── weekAttendance: the Year page's per-subject core rows ────
import { weekAttendance } from '../js/plan/model.js';

// The live template, in miniature: Quran Mon/Wed/Fri, Ruhama Mon/Tue/Thu/Sat/Sun,
// Miss Hala Tue/Wed/Thu — plus the corrupt {id:'e999'} record the real blob has
// carried since v1, which must never be counted as a session.
const TPL = [
  { id: 'e999' },
  { id: 'q1', cat: 'quran', day: 0, start: 10, end: 11 },
  { id: 'q3', cat: 'quran', day: 2, start: 10, end: 11 },
  { id: 'q5', cat: 'quran', day: 4, start: 10, end: 11 },
  { id: 'r1', cat: 'ruhamah', day: 0, start: 11, end: 13 },
  { id: 'r2', cat: 'ruhamah', day: 1, start: 11, end: 12 },
  { id: 'r4', cat: 'ruhamah', day: 3, start: 11, end: 12 },
  { id: 'r6', cat: 'ruhamah', day: 5, start: 11, end: 13 },
  { id: 'r7', cat: 'ruhamah', day: 6, start: 11, end: 13 },
  { id: 'h2', cat: 'hala', day: 1, start: 14, end: 15 },
  { id: 'h3', cat: 'hala', day: 2, start: 14, end: 15 },
  { id: 'h4', cat: 'hala', day: 3, start: 14, end: 15 },
];
const WK = '2026-08-17';                      // a Monday
const ok = (date, eventId, status = 'done') => ({ date, eventId, status, timed: true });
const att = (plan, cat, week = WK) => weekAttendance(TPL, plan, week, cat);

test('weekAttendance: an empty log expects the full week and counts nothing done', () => {
  const p = { periods: [], overrides: [], log: [] };
  assert.deepEqual(att(p, 'quran'), { expected: 3, done: 0 });
  assert.deepEqual(att(p, 'ruhamah'), { expected: 5, done: 0 });
  assert.deepEqual(att(p, 'hala'), { expected: 3, done: 0 });
  // A missing plan, or one with no lists at all, must not throw.
  assert.deepEqual(weekAttendance(TPL, null, WK, 'quran'), { expected: 3, done: 0 });
  assert.deepEqual(weekAttendance(null, {}, WK, 'quran'), { expected: 0, done: 0 });
  // A category with no template events at all (Art) is a 0/0 row, not an error.
  assert.deepEqual(att(p, 'art'), { expected: 0, done: 0 });
  // A NULL category matches nothing — never the corrupt {id:'e999'} record,
  // whose own `cat` is undefined too.
  assert.deepEqual(att(p, undefined), { expected: 0, done: 0 });
  assert.deepEqual(att(p, null), { expected: 0, done: 0 });
});

test('weekAttendance: every scheduled session ticked is a full week', () => {
  const p = { periods: [], overrides: [],
    log: [ok('2026-08-17', 'q1'), ok('2026-08-19', 'q3'), ok('2026-08-21', 'q5')] };
  assert.deepEqual(att(p, 'quran'), { expected: 3, done: 3 });
});

test('weekAttendance: a partial week, and only `done` counts', () => {
  const p = { periods: [], overrides: [], log: [
    ok('2026-08-17', 'r1'),                    // Mon done
    ok('2026-08-18', 'r2'),                    // Tue done
    ok('2026-08-20', 'r4', 'partial'),         // Thu half-finished — not done
    ok('2026-08-22', 'r6', 'missed'),          // Sat missed
  ] };
  assert.deepEqual(att(p, 'ruhamah'), { expected: 5, done: 2 });
});

test('weekAttendance: the log is windowed to Mon..Sun of the week asked for', () => {
  const p = { periods: [], overrides: [], log: [
    ok('2026-08-16', 'r7'),                    // the Sunday BEFORE this week
    ok('2026-08-17', 'r1'),                    // in
    ok('2026-08-23', 'r7'),                    // the Sunday of this week — in
    ok('2026-08-24', 'r1'),                    // next Monday
  ] };
  assert.deepEqual(att(p, 'ruhamah'), { expected: 5, done: 2 });
  assert.deepEqual(att(p, 'ruhamah', '2026-08-24'), { expected: 5, done: 1 });
});

test('weekAttendance: away days reduce `expected`, so a trip is never a wall of misses', () => {
  // Mon–Wed away: Quran loses Mon+Wed (Fri survives), Hala loses Tue+Wed.
  const p = { periods: [{ id: 'p1', start: '2026-08-17', end: '2026-08-19', type: 'travel' }],
              overrides: [], log: [ok('2026-08-21', 'q5')] };
  assert.deepEqual(att(p, 'quran'), { expected: 1, done: 1 });
  assert.deepEqual(att(p, 'hala'), { expected: 1, done: 0 });
  // A whole week away expects nothing at all — the row draws hatch only.
  const off = { periods: [{ id: 'p2', start: '2026-08-15', end: '2026-08-30', type: 'off' }],
                overrides: [], log: [] };
  assert.deepEqual(att(off, 'quran'), { expected: 0, done: 0 });
  assert.deepEqual(att(off, 'ruhamah'), { expected: 0, done: 0 });
});

test('weekAttendance: a `skip` override cancels that one session', () => {
  const p = { periods: [], overrides: [
    { date: '2026-08-19', action: 'skip', eventId: 'q3' },     // Wed Quran cancelled
    { date: '2026-08-19', action: 'skip', eventId: 'h3' },     // Wed Hala cancelled
  ], log: [ok('2026-08-17', 'q1'), ok('2026-08-21', 'q5')] };
  assert.deepEqual(att(p, 'quran'), { expected: 2, done: 2 });  // 2 of 2 = a full week
  assert.deepEqual(att(p, 'hala'), { expected: 2, done: 0 });
  // A skip on a DIFFERENT date, or for a different event, changes nothing.
  const other = { periods: [], overrides: [
    { date: '2026-08-26', action: 'skip', eventId: 'q3' },      // next week
    { date: '2026-08-19', action: 'skip', eventId: 'r4' },      // another subject
    { date: '2026-08-19', action: 'add', eventId: 'q3' },       // not a skip
  ], log: [] };
  assert.deepEqual(att(other, 'quran'), { expected: 3, done: 0 });
});

test('weekAttendance: a dated one-off logs against its own id and never inflates a row', () => {
  // The bot's "Arya art" one-off (override id x1) is logged done in this very
  // week. It belongs to no template event, so no core row may count it.
  const p = { periods: [],
    overrides: [{ date: '2026-08-18', action: 'add', id: 'x1', name: 'Arya art', start: 15.5, end: 16.5 }],
    log: [ok('2026-08-18', 'x1'), { date: '2026-08-18', activityId: 'loe', status: 'done' }] };
  assert.deepEqual(att(p, 'quran'), { expected: 3, done: 0 });
  assert.deepEqual(att(p, 'ruhamah'), { expected: 5, done: 0 });
  assert.deepEqual(att(p, 'art'), { expected: 0, done: 0 });
});
