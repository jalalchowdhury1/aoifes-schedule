// Per-period travel factors (2026-09-05): a `travel` period may carry
// `factors: { <activityId>: 0..1 }` — what ONE day of THAT trip is worth to
// THAT activity, overriding the activity's own `travel` mode for that trip
// only. Motivation: Singapore Math runs every-other-day (0.5) across the
// 35-day winter trip, but the family wants at least 4 lessons over the 6-day
// DC trip (Sep 30 – Oct 5) — 4/6 ≈ 0.67 — without touching the winter pace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayWeight, effectiveDaysInWeek, sanitizePlan } from '../js/plan/model.js';

const SM = { id: 'singapore', travel: { mode: 'reduced', factor: 0.5 } };
const GEO = { id: 'geography', travel: { mode: 'pause' } };
const DC = { id: 'p2', start: '2026-09-30', end: '2026-10-05', type: 'travel',
  factors: { singapore: 0.67 } };

test('dayWeight: a trip day is worth the period\'s own factor for that activity', () => {
  assert.equal(dayWeight(SM, '2026-10-01', [DC]), 0.67);
});

test('dayWeight: an activity the period does not name keeps its own travel mode', () => {
  assert.equal(dayWeight(GEO, '2026-10-01', [DC]), 0);                       // pause, as before
  const plain = { ...DC, factors: undefined };
  assert.equal(dayWeight(SM, '2026-10-01', [plain]), 0.5);                   // no factors -> old rule
});

test('dayWeight: the period factor is the more specific claim and beats a pause mode', () => {
  const dc = { ...DC, factors: { geography: 1 } };
  assert.equal(dayWeight(GEO, '2026-10-01', [dc]), 1);
});

test('dayWeight: an off day still zeroes everything, factor or not', () => {
  const off = { id: 'o1', start: '2026-10-01', end: '2026-10-01', type: 'off', factors: { singapore: 1 } };
  assert.equal(dayWeight(SM, '2026-10-01', [DC, off]), 0);
});

test('dayWeight: garbage factor values read as "not set" — same set the bot rejects', () => {
  for (const bad of ['x', null, true, false, 0, -1, 1.5, NaN, Infinity]) {
    const dc = { ...DC, factors: { singapore: bad } };
    assert.equal(dayWeight(SM, '2026-10-01', [dc]), 0.5, `factor ${String(bad)}`);
  }
  assert.equal(dayWeight(SM, '2026-10-01', [{ ...DC, factors: 'nope' }]), 0.5);
});

test('dayWeight: a factors ARRAY is not a map, even for a numeric-string activity id', () => {
  // Python's `isinstance(factors, dict)` rejects a list; JS must not let
  // `[0.9]["0"]` resolve to an index and hand back a phantom 0.9 (a value the
  // fallback could never produce, so the assertion can tell the two apart).
  const zero = { id: '0', travel: { mode: 'reduced', factor: 0.5 } };
  assert.equal(dayWeight(zero, '2026-10-01', [{ ...DC, factors: [0.9] }]), 0.5);
});

test('dayWeight: outside the period the factor has no effect', () => {
  assert.equal(dayWeight(SM, '2026-10-06', [DC]), 1);
});

test('effectiveDaysInWeek: the DC week prices Mon/Tue at 1 and the five trip days at 0.67', () => {
  // week of Mon Sep 28: Mon, Tue plain; Wed Sep 30 .. Sun Oct 4 inside the trip
  const n = effectiveDaysInWeek(SM, '2026-09-28', [DC]);
  assert.ok(Math.abs(n - (2 + 5 * 0.67)) < 1e-9, `got ${n}`);
});

test('sanitizePlan keeps a well-formed factors map on a period', () => {
  const out = sanitizePlan({ periods: [DC] });
  assert.deepEqual(out.periods[0].factors, { singapore: 0.67 });
});

test('sanitizePlan drops factor entries that are not numbers in (0, 1]', () => {
  const dirty = { ...DC, factors: { singapore: 0.67, loe: 0, geography: 1.5, science: 'x', jj: NaN, art: 1 } };
  const out = sanitizePlan({ periods: [dirty] });
  assert.deepEqual(out.periods[0].factors, { singapore: 0.67, art: 1 });
});

test('sanitizePlan omits the key entirely when no entry survives (or none was given)', () => {
  assert.equal('factors' in sanitizePlan({ periods: [{ ...DC, factors: { loe: 7 } }] }).periods[0], false);
  assert.equal('factors' in sanitizePlan({ periods: [{ ...DC, factors: undefined }] }).periods[0], false);
  assert.equal('factors' in sanitizePlan({ periods: [{ ...DC, factors: 'nope' }] }).periods[0], false);
});
