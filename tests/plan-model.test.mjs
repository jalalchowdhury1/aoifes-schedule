import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, dayIdx, mondayOf, weeksBetween, weekType, isOnWeek,
  sessionsCount, nextSession, actTotal, actDone, actRemaining,
  sanitizePlan,
} from '../js/plan/model.js';

test('date helpers: Mon-first indexing and week math', () => {
  assert.equal(dayIdx('2026-08-16'), 6);            // Sunday
  assert.equal(dayIdx('2026-08-17'), 0);            // Monday
  assert.equal(mondayOf('2026-08-16'), '2026-08-10');
  assert.equal(mondayOf('2026-08-17'), '2026-08-17');
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(weeksBetween('2026-08-17', '2026-08-31'), 2);
  assert.equal(weeksBetween('2026-08-17', '2026-08-23'), 0);
});

test('weekType defaults to teaching, reads marked weeks by any date in week', () => {
  const weeks = { '2027-01-04': { type: 'travel', label: 'Dhaka' } };
  assert.equal(weekType(weeks, '2027-01-07'), 'travel'); // Thu of that week
  assert.equal(weekType(weeks, '2026-12-30'), 'teaching');
});

test('isOnWeek: anchor week is a work week, alternating', () => {
  const cyc = { anchorMonday: '2026-08-17' };
  assert.equal(isOnWeek(cyc, '2026-08-20'), true);   // anchor week
  assert.equal(isOnWeek(cyc, '2026-08-24'), false);  // next week = home
  assert.equal(isOnWeek(cyc, '2026-08-31'), true);
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
    weeks: { '2027-01-04': { type: 'travel' }, bad: { type: 'nope' } },
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
  assert.equal(Object.keys(p.weeks).length, 1);
  assert.equal(p.activities.length, 1);
  assert.equal(p.log.length, 1);
  assert.deepEqual(p.overrides, []);
  const empty = sanitizePlan(null);
  assert.equal(empty.version, 1);
  assert.ok(Array.isArray(empty.activities));
});

import {
  weekCapacity, projectFinish, requiredPerCycle, cycleBounds, cycleStats,
  targetStats, findClashes, freeSlots, doneOn,
} from '../js/plan/model.js';

const LOE = {
  id: 'loe', type: 'paced', status: 'active',
  rhythm: { kind: 'cycle', perOnWeek: 1, perOffWeek: 2.5 },
  travel: { mode: 'pause' },
  goal: { finishBy: '2027-08-31' },
  chain: [
    { id: 'loe-c', pattern: 'simple', firstUnit: 81, lastUnit: 120, done: 21 },
    { id: 'loe-d', pattern: 'simple', firstUnit: 121, lastUnit: 140, done: 0 },
  ],
};
const SM = {
  id: 'singapore', type: 'paced', status: 'active',
  rhythm: { kind: 'daily' }, travel: { mode: 'reduced', factor: 0.5 },
  chain: [{ id: 'dm3', pattern: 'tb-wb', lessons: 60, tests: 14, done: 0 }],
};
const CYC = { anchorMonday: '2026-08-17', confirmed: false };
const JAN_TRIP = {};
for (let i = 0; i < 5; i++) JAN_TRIP[addDays('2027-01-04', i * 7)] = { type: 'travel', label: 'Dhaka' };

test('weekCapacity: rhythms × week types', () => {
  assert.equal(weekCapacity(SM, '2026-08-17', {}, CYC), 7);              // daily teaching
  assert.equal(weekCapacity(SM, '2027-01-04', JAN_TRIP, CYC), 3.5);      // daily reduced travel
  assert.equal(weekCapacity(LOE, '2026-08-17', {}, CYC), 1);             // cycle, work week
  assert.equal(weekCapacity(LOE, '2026-08-24', {}, CYC), 2.5);           // cycle, home week
  assert.equal(weekCapacity(LOE, '2027-01-04', JAN_TRIP, CYC), 0);       // pause on travel
  const geo = { rhythm: { kind: 'weekly', perWeek: 1 }, travel: { mode: 'pause' } };
  assert.equal(weekCapacity(geo, '2026-08-17', {}, CYC), 1);
  assert.equal(weekCapacity(geo, '2026-08-17', { '2026-08-17': { type: 'light' } }, CYC), 0.5);
  assert.equal(weekCapacity(geo, '2026-08-17', { '2026-08-17': { type: 'off' } }, CYC), 0);
});

test('LoE projection: C ~Nov 2026, C+D Feb-Mar 2027 with Jan trip, before goal', () => {
  // 39 sessions left at 3.5/cycle from 2026-08-17 with a 5-week January travel pause.
  const fin = projectFinish(LOE, '2026-08-17', { weeks: JAN_TRIP, parentCycle: CYC });
  assert.ok(fin.date >= '2027-02-01' && fin.date <= '2027-03-31', fin.date);
  assert.ok(fin.date < LOE.goal.finishBy);
  // C alone (clone with D emptied) lands around Nov 2026.
  const cOnly = { ...LOE, chain: [LOE.chain[0]] };
  const finC = projectFinish(cOnly, '2026-08-17', { weeks: {}, parentCycle: CYC });
  assert.ok(finC.date >= '2026-10-15' && finC.date <= '2026-11-30', finC.date);
});

test('LoE minimum pace to hit the goal is about 2 per cycle', () => {
  const need = requiredPerCycle(LOE, '2026-08-17', { weeks: JAN_TRIP, parentCycle: CYC });
  assert.ok(need > 1 && need < 2.5, String(need));
});

test('unknown counts (waiting for books) -> no projection', () => {
  const waiting = { ...SM, chain: [{ pattern: 'tb-wb', lessons: 0, tests: 0, done: 0 }] };
  assert.equal(projectFinish(waiting, '2026-08-17', { weeks: {}, parentCycle: CYC }), null);
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
  const plan = { year: { start: '2026-09-01', end: '2027-08-31' }, weeks: JAN_TRIP, parentCycle: CYC };
  const log = Array.from({ length: 3 }, (_, i) =>
    ({ date: addDays('2026-09-05', i * 14), activityId: 'jj', status: 'done' }));
  const st = targetStats(jj, plan, log, '2026-11-10');
  assert.equal(st.done, 3);
  assert.ok(st.expected >= 4 && st.expected <= 5, String(st.expected)); // 20 * 11/48
  assert.ok(st.behind >= 1);
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
