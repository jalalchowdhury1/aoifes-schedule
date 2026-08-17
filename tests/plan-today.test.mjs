import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayStr, addDays, dayIdx, sanitizePlan } from '../js/plan/model.js';

// today.js imports js/plan/state.js, which touches localStorage/fetch/document
// at module scope on commit() (see tests/plan-state.test.mjs). renderToday()
// itself never mutates the plan, but stub the globals before importing anyway
// so the module graph is safe regardless of import order.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.fetch = () => Promise.resolve({ json: async () => ({}) });
// No prompt/alert/confirm anywhere in the planner (phones can't dismiss native
// dialogs cleanly) — fail loudly if renderToday() ever reaches for one.
for (const k of ['alert', 'confirm', 'prompt'])
  globalThis[k] = () => { throw new Error(`${k}() must never be called by the planner`); };

// Minimal DOM stub: renderToday() only ever touches #view-today, setting its
// innerHTML and (for click wiring) calling querySelectorAll on it.
class FakeEl {
  constructor() { this._html = ''; }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  querySelectorAll() { return []; }
}
const viewToday = new FakeEl();
globalThis.document = {
  getElementById: id => (id === 'view-today' ? viewToday : null),
  dispatchEvent: () => {},
};

const { store } = await import('../js/state.js');
const { plan } = await import('../js/plan/state.js');
const { renderToday, fmtUntil, dailyVisible } = await import('../js/plan/today.js');

// ── Pure helpers ─────────────────────────────────────────────
test('fmtUntil: days under 2 weeks, weeks beyond', () => {
  assert.equal(fmtUntil(1), 'in 1 day');
  assert.equal(fmtUntil(5), 'in 5 days');
  assert.equal(fmtUntil(13), 'in 13 days');
  assert.equal(fmtUntil(14), 'in 2 wks');
  assert.equal(fmtUntil(21), 'in 3 wks');
  assert.equal(fmtUntil(10 * 7), 'in 10 wks');
});

test('dailyVisible: normal day always visible; travel-day respects travel.mode; off-day hides all', () => {
  const reduced = { travel: { mode: 'reduced', factor: 0.5 } };
  const pause = { travel: { mode: 'pause' } };
  const noTravel = {};                                    // no travel field defaults to pause
  const away = (t) => ({ away: true, type: t });
  assert.equal(dailyVisible(reduced, { away: false }), true);
  assert.equal(dailyVisible(pause, { away: false }), true);
  assert.equal(dailyVisible(reduced, away('travel')), true);
  assert.equal(dailyVisible(pause, away('travel')), false);
  assert.equal(dailyVisible(noTravel, away('travel')), false);
  assert.equal(dailyVisible(reduced, away('off')), false);
  assert.equal(dailyVisible(pause, away('off')), false);
});

// ── renderToday() smoke, DOM-stubbed ────────────────────────
const SM = {
  id: 'sm', name: 'Singapore Math', type: 'paced', status: 'active', onGrid: false,
  rhythm: { kind: 'daily' }, travel: { mode: 'reduced', factor: 0.5 },
  chain: [{ id: 'sm-c', pattern: 'tb-wb', lessons: 5, tests: 1, done: 0 }],
};
const LOE = {
  id: 'loe', name: 'Logic of English', type: 'paced', status: 'active', onGrid: false,
  rhythm: { kind: 'cycle', perOnWeek: 1, perOffWeek: 2.5 }, travel: { mode: 'pause' },
  chain: [{ id: 'loe-c', pattern: 'simple', firstUnit: 1, lastUnit: 10, done: 0 }],
};

function loadPlan(periods) {
  plan.data = sanitizePlan({
    year: { label: 'y', start: '2026-08-17', end: '2027-08-31' },
    parentCycle: { anchorMonday: '2026-08-17', dutyStart: '2026-08-11', confirmed: true },
    periods, activities: [SM, LOE], log: [], overrides: [],
  });
}

const TODAY = todayStr();
const TODAY_DI = dayIdx(TODAY);

test('renderToday: (a) normal day — Mama chip via isWorkDay, timed block + both dailies render', () => {
  store.events = [{ id: 'e1', cat: 'quran', day: TODAY_DI, start: 10, end: 11, name: 'Quran reading' }];
  loadPlan([]);
  renderToday();
  const html = viewToday.innerHTML;
  // 2026-08-11 is the real dutyStart in prod; today (2026-08-17, Monday) is a
  // work day under it (last day of the Tue->Mon stretch).
  assert.match(html, /Mama: work day/);
  assert.doesNotMatch(html, /Mama: home day/);
  assert.match(html, /class="tblock/);
  assert.match(html, /Quran reading/);
  assert.doesNotMatch(html, /abanner/);
  assert.match(html, /Singapore Math/);
  assert.match(html, /Logic of English/);
});

test('renderToday: (b) travel day mid-period — banner shown, timed blocks hidden, reduced daily stays, paused daily hides', () => {
  store.events = [{ id: 'e1', cat: 'quran', day: TODAY_DI, start: 10, end: 11, name: 'Quran reading' }];
  const start = addDays(TODAY, -2), end = addDays(TODAY, 5);      // 8-day trip, today is day 3
  loadPlan([{ id: 'p1', start, end, type: 'travel', label: 'Dhaka ✈' }]);
  renderToday();
  const html = viewToday.innerHTML;
  assert.match(html, /abanner/);
  assert.match(html, /✈ Dhaka · day 3 of 8/);
  assert.doesNotMatch(html, /class="tblock/);
  assert.doesNotMatch(html, /Quran reading/);
  assert.match(html, /Singapore Math/);                    // reduced -> still shows
  assert.doesNotMatch(html, /Logic of English/);            // pause -> hidden
});

test('renderToday: (c) off-type day — banner shown, no dailies section at all', () => {
  store.events = [];
  loadPlan([{ id: 'p2', start: TODAY, end: TODAY, type: 'off' }]);
  renderToday();
  const html = viewToday.innerHTML;
  assert.match(html, /abanner/);
  assert.match(html, /⏸ Off · day 1 of 1/);
  assert.doesNotMatch(html, /Daily · no time slot/);
  assert.doesNotMatch(html, /Singapore Math/);
  assert.doesNotMatch(html, /Logic of English/);
});

test('renderToday: (d) tomorrow away — tomorrow strip shows the trip instead of a class list', () => {
  store.events = [{ id: 'e2', cat: 'quran', day: dayIdx(addDays(TODAY, 1)), start: 9, end: 10, name: 'Should be hidden' }];
  const tStart = addDays(TODAY, 1), tEnd = addDays(TODAY, 3);
  loadPlan([{ id: 'p3', start: tStart, end: tEnd, type: 'travel', label: 'Ski trip' }]);
  renderToday();
  const html = viewToday.innerHTML;
  assert.doesNotMatch(html, /abanner/);                    // today itself is not away
  assert.match(html, /Tomorrow: ✈ Ski trip/);
  assert.doesNotMatch(html, /Should be hidden/);
});
