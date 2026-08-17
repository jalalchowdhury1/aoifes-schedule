import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedPlan } from '../js/plan/seed.js';
import {
  sanitizePlan, serializePlan, actDone, nextSession, currentCur,
  requiredPerCycle, targetStats,
} from '../js/plan/model.js';

// state.js touches localStorage / fetch / document at module scope and on every
// commit(). Stub the browser globals BEFORE importing it (dynamic import below).
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.fetch = () => Promise.resolve({ json: async () => ({}) });
globalThis.document = { dispatchEvent: () => {} };
const { plan, initPlan, togglePaced } = await import('../js/plan/state.js');

const curOf = (p, actId, curId) =>
  p.activities.find(a => a.id === actId).chain.find(c => c.id === curId);
// savePlan() stamps savedAt on every commit; ignore it when comparing states.
const snap = p => { const c = JSON.parse(JSON.stringify(p)); delete c.savedAt; return c; };
const D = '2026-09-01';                    // fixed date so the run is not clock-dependent

test('seed survives sanitize round-trip unchanged', () => {
  const p = seedPlan();
  const round = sanitizePlan(JSON.parse(serializePlan(p)));
  assert.deepEqual(round, p);
});

test('seed facts: LoE active at lesson 101 done; Singapore waiting; template untouched', () => {
  const p = seedPlan();
  const loe = p.activities.find(a => a.id === 'loe');
  assert.equal(loe.status, 'active');
  assert.equal(actDone(loe), 21);                          // lessons 81..101
  assert.equal(nextSession(currentCur(loe)).label, 'Lesson 102');
  assert.equal(loe.goal.finishBy, '2027-08-31');
  const sm = p.activities.find(a => a.id === 'singapore');
  assert.equal(sm.status, 'planned');                      // waiting for G3 books
  const sci = p.activities.find(a => a.id === 'science');
  assert.equal(sci.status, 'planned');
  assert.deepEqual(sci.slots, [{ day: 1, start: 14.5, end: 15.5 }]);
  const jj = p.activities.find(a => a.id === 'jj');
  assert.equal(jj.status, 'planned');
  assert.equal(jj.target, 20);
  const hist = p.activities.find(a => a.id === 'history');
  assert.equal(hist.status, 'parked');
  assert.equal(p.parentCycle.confirmed, false);            // anchor parity is a guess
  assert.deepEqual(p.weeks, {});                           // no invented trip dates
  assert.equal(p.log.length, 1);                           // the known 8/16 LoE lesson
});

// ── togglePaced mutation invariants (I1) ────────────────────
test('togglePaced: check then uncheck is the identity (mid-chain)', () => {
  initPlan();
  const before = snap(plan.data);
  assert.equal(curOf(plan.data, 'loe', 'loe-c').done, 21);

  togglePaced('loe', D);
  assert.equal(curOf(plan.data, 'loe', 'loe-c').done, 22);
  const entry = plan.data.log.find(e => e.date === D && e.activityId === 'loe');
  assert.equal(entry.curriculum, 'loe-c');
  assert.equal(entry.session, 21);

  togglePaced('loe', D);
  assert.deepEqual(snap(plan.data), before);
});

test('togglePaced: uncheck decrements the LOGGED curriculum, not the last progressed one', () => {
  initPlan();
  // Finish C entirely and start D: the "last curriculum with progress" is now D.
  curOf(plan.data, 'loe', 'loe-c').done = 40;
  curOf(plan.data, 'loe', 'loe-d').done = 3;
  togglePaced('loe', D);                       // advances D (currentCur) 3 -> 4
  assert.equal(curOf(plan.data, 'loe', 'loe-d').done, 4);
  assert.equal(curOf(plan.data, 'loe', 'loe-c').done, 40);
  togglePaced('loe', D);
  assert.equal(curOf(plan.data, 'loe', 'loe-d').done, 3);
  assert.equal(curOf(plan.data, 'loe', 'loe-c').done, 40);   // C never touched
});

test('togglePaced: exhausted chain round-trips with no negative counts', () => {
  initPlan();
  curOf(plan.data, 'loe', 'loe-c').done = 40;   // 81..120
  curOf(plan.data, 'loe', 'loe-d').done = 20;   // 121..140
  assert.equal(currentCur(plan.data.activities.find(a => a.id === 'loe')), null);
  const before = snap(plan.data);

  togglePaced('loe', D);
  const entry = plan.data.log.find(e => e.date === D && e.activityId === 'loe');
  assert.equal('curriculum' in entry, false);   // nothing advanced -> nothing recorded
  assert.equal(curOf(plan.data, 'loe', 'loe-c').done, 40);
  assert.equal(curOf(plan.data, 'loe', 'loe-d').done, 20);

  togglePaced('loe', D);
  assert.deepEqual(snap(plan.data), before);
});

// ── sanitize date guards + walk caps (I2) ───────────────────
test('sanitizePlan: malformed dates fall back to defaults and bad rows are dropped', () => {
  const p = sanitizePlan({
    year: { label: 'bad', start: '2026-08-17', end: 'zzz' },
    parentCycle: { pattern: '7on7off', anchorMonday: 'nope', confirmed: true },
    weeks: { 'zzz': { type: 'travel' }, '2026-12-21': { type: 'travel' } },
    activities: [
      { id: 'a1', type: 'paced', goal: { finishBy: 'zzz' }, chain: [] },
      { id: 'a2', type: 'paced', goal: { finishBy: '2027-08-31' }, chain: [] },
    ],
    log: [{ date: 'zzz', activityId: 'a1', status: 'done' },
          { date: '2026-08-16', activityId: 'a1', status: 'done' }],
    overrides: [{ date: 'zzz', action: 'skip' }, { date: '2026-09-02', action: 'skip' }],
  });
  assert.equal(p.year.end, '2027-08-31');                 // whole default year object
  assert.equal(p.year.label, '2026-27');
  assert.equal(p.parentCycle.anchorMonday, '2026-08-17');
  assert.equal(p.parentCycle.confirmed, false);           // whole default parentCycle
  assert.deepEqual(Object.keys(p.weeks), ['2026-12-21']);
  assert.equal(p.activities[0].goal, undefined);          // invalid goal deleted
  assert.equal(p.activities[1].goal.finishBy, '2027-08-31');
  assert.equal(p.log.length, 1);
  assert.equal(p.overrides.length, 1);
});

test('week-walk loops terminate on a malformed date (600-iteration cap)', () => {
  const p = sanitizePlan({});
  const act = { id: 'x', type: 'paced', goal: { finishBy: 'zzz' },
                rhythm: { kind: 'weekly', perWeek: 1 },
                chain: [{ id: 'c', pattern: 'simple', firstUnit: 1, lastUnit: 10, done: 0 }] };
  const need = requiredPerCycle(act, '2026-08-17', p);    // must RETURN, not hang
  assert.equal(need === null || Number.isFinite(need), true);

  const st = targetStats({ id: 'x', target: 20 },
    { ...p, year: { start: '2026-08-17', end: 'zzz' } }, [], '2026-09-01');
  assert.equal(Number.isFinite(st.expected), true);
});

test('sanitizePlan drops a chain entry lacking id (togglePaced needs it)', () => {
  const p = sanitizePlan({ activities: [{ id: 'a1', type: 'paced', chain: [
    { id: 'good', pattern: 'simple', firstUnit: 1, lastUnit: 5, done: 0 },
    { pattern: 'simple', firstUnit: 6, lastUnit: 9, done: 0 },   // no id -> dropped
  ] }] });
  assert.deepEqual(p.activities[0].chain.map(c => c.id), ['good']);
});
