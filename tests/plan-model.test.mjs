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
