// Red-team 2026-09-05 (UI, M1/L1). A weekly/cycle rhythm prices each day at a
// 1/7 smear, so two day-precise walks anchored on different weekdays can drift
// a whole week band-to-band while the true pace is steady: LoE's chapter rows
// read "▼ 1 wk behind" on four rows and "on plan" on the rest. The per-row
// chip for such rhythms needs a tolerance of one full rhythm period, not 7 days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDeltaChip, plural } from '../js/plan/model.js';

test('planDeltaChip: default tolerance is unchanged (±7 days = on plan)', () => {
  assert.deepEqual(planDeltaChip('2026-09-25', '2026-09-18'), { state: 'on', weeks: 0 });
  assert.deepEqual(planDeltaChip('2026-09-26', '2026-09-18'), { state: 'behind', weeks: 1 });
  assert.deepEqual(planDeltaChip('2026-09-10', '2026-09-18'), { state: 'ahead', weeks: 1 });
});

test('planDeltaChip: a wider tolerance absorbs the one-week smear of a weekly/cycle rhythm', () => {
  // LoE live rows 2026-09-05: plan Sep 18 -> now Sep 26 (8 days) must read "on"
  assert.deepEqual(planDeltaChip('2026-09-26', '2026-09-18', 14), { state: 'on', weeks: 0 });
  assert.deepEqual(planDeltaChip('2027-05-10', '2027-05-01', 14), { state: 'on', weeks: 0 });   // 9 days
  assert.deepEqual(planDeltaChip('2026-10-03', '2026-09-18', 14), { state: 'behind', weeks: 2 }); // 15 days
  assert.equal(planDeltaChip(null, '2026-09-18', 14), null);
});

test('plural: singular at exactly one, plural otherwise', () => {
  assert.equal(plural(1, 'wk'), '1 wk');
  assert.equal(plural(2, 'wk'), '2 wks');
  assert.equal(plural(0, 'week'), '0 weeks');
  assert.equal(plural(14, 'week'), '14 weeks');
});
