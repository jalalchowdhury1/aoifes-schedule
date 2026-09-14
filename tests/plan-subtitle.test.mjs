// Optional activity `subtitle` (2026-09-14, user: "Instead of Dunavant Geography
// it should just say Geography and underneath where it says lesson 3 it should
// say Dunavant Academy"). The subtitle replaces the next-lesson line on the
// phone day card (buildTimed) and the week grid block (gridSlots).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizePlan, gridSlots, mondayOf, subtitleOf } from '../js/plan/model.js';
import { buildTimed } from '../js/plan/mday.js';

const events = JSON.parse(readFileSync(new URL('./fixtures/plan-mday-schedule.json', import.meta.url), 'utf8')).events;
const rawPlan = JSON.parse(readFileSync(new URL('./fixtures/plan-mday-plan.json', import.meta.url), 'utf8'));
const MON = '2026-08-31';
const withSub = sub => sanitizePlan({ ...rawPlan,
  activities: rawPlan.activities.map(a => (a.id === 'jj' ? { ...a, subtitle: sub } : a)) });

test('subtitleOf: a non-blank string wins, anything else is empty', () => {
  assert.equal(subtitleOf({ subtitle: ' Dunavant Academy ' }), 'Dunavant Academy');
  assert.equal(subtitleOf({ subtitle: '   ' }), '');
  assert.equal(subtitleOf({ subtitle: 7 }), '');
  assert.equal(subtitleOf({}), '');
  assert.equal(subtitleOf(null), '');
});

test('subtitle survives sanitizePlan (unknown fields are kept)', () => {
  assert.equal(withSub('Dunavant Academy').activities.find(a => a.id === 'jj').subtitle, 'Dunavant Academy');
});

test('buildTimed: the subtitle replaces the lesson line on the day card', () => {
  const jj = buildTimed(MON, events, withSub('Dunavant Academy')).find(it => it.activityId === 'jj');
  assert.equal(jj.note, 'Dunavant Academy');
});

test('gridSlots: the subtitle replaces the lesson line on the grid block', () => {
  const p = withSub('Dunavant Academy');
  const blocks = gridSlots(p.activities, p.overrides, mondayOf(MON)).filter(b => b.actId === 'jj');
  assert.ok(blocks.length > 0);
  for (const b of blocks) assert.equal(b.note, 'Dunavant Academy');
});

test('a blank subtitle falls back to the old lesson line exactly', () => {
  const plain = sanitizePlan(rawPlan);
  const before = buildTimed(MON, events, plain).find(it => it.activityId === 'jj').note;
  const after = buildTimed(MON, events, withSub('  ')).find(it => it.activityId === 'jj').note;
  assert.equal(after, before);
});
