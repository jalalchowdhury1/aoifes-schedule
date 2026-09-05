// Defence-in-depth for plans written by scripts/API rather than the editor
// (red-team 2026-09-05, M1/M2). Neither case is reachable from the live data
// or the UI (sanitizePlan always supplies parentCycle; the editor only writes
// factors it offers) — but the math must not silently corrupt or crash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayWeight, dayCapacity, projectFinish } from '../js/plan/model.js';

const TRIP = { id: 'p1', start: '2026-09-08', end: '2026-09-10', type: 'travel' };
const reduced = factor => ({ id: 'x', travel: { mode: 'reduced', factor } });

test('M1 dayWeight: a reduced factor outside (0, 1] or non-numeric reads as the default ½, never negative', () => {
  for (const bad of [-5, 0, 1.5, NaN, Infinity, -Infinity, '0.7', true, null])
    assert.equal(dayWeight(reduced(bad), '2026-09-09', [TRIP]), 0.5, `factor ${String(bad)}`);
  assert.equal(dayWeight(reduced(0.25), '2026-09-09', [TRIP]), 0.25);   // a valid one still applies
  assert.equal(dayWeight(reduced(1), '2026-09-09', [TRIP]), 1);
  assert.equal(dayWeight(reduced(undefined), '2026-09-09', [TRIP]), 0.5);
});

test('M1 the walk never goes backwards: a negative factor cannot subtract from the accumulator', () => {
  const act = { id: 'x', type: 'paced', status: 'active', rhythm: { kind: 'daily' },
    travel: { mode: 'reduced', factor: -5 },
    chain: [{ id: 'c', pattern: 'simple', firstUnit: 1, lastUnit: 3, done: 0 }] };
  const plan = { periods: [TRIP], parentCycle: { anchorMonday: '2026-08-10', dutyStart: '2026-08-11' }, overrides: [], log: [] };
  // Mon 1, Tue ½ (default), Wed ½, Thu ½ (2.5), Fri 1 ≥ 3 → Fri Sep 11
  assert.equal(projectFinish(act, '2026-09-07', plan).date, '2026-09-11');
  for (const d of ['2026-09-08', '2026-09-09', '2026-09-10']) assert.ok(dayCapacity(act, d, plan) >= 0, d);
});

test('M2 a cycle rhythm on a plan with no parentCycle does not throw and uses the default anchor (bot parity)', () => {
  const act = { id: 'loe', type: 'paced', status: 'active', rhythm: { kind: 'cycle', perOnWeek: 1, perOffWeek: 2.5 },
    travel: { mode: 'pause' }, chain: [{ id: 'c', pattern: 'simple', firstUnit: 1, lastUnit: 6, done: 0 }] };
  const bare = { periods: [], overrides: [], log: [] };                       // no parentCycle at all
  const dflt = { ...bare, parentCycle: { anchorMonday: '2026-08-17' } };      // compose.DEFAULT_ANCHOR_MONDAY
  assert.doesNotThrow(() => dayCapacity(act, '2026-09-07', bare));
  assert.equal(dayCapacity(act, '2026-09-07', bare), dayCapacity(act, '2026-09-07', dflt));
  assert.deepEqual(projectFinish(act, '2026-09-07', bare), projectFinish(act, '2026-09-07', dflt));
  assert.equal(dayCapacity(act, '2026-09-07', { ...bare, parentCycle: { anchorMonday: 'garbage' } }),
    dayCapacity(act, '2026-09-07', dflt));
});
