import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedPlan } from '../js/plan/seed.js';
import { sanitizePlan, serializePlan, actDone, nextSession, currentCur } from '../js/plan/model.js';

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
