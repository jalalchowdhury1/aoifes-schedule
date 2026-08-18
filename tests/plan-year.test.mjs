import { test } from 'node:test';
import assert from 'node:assert/strict';

// year.js pulls in js/plan/state.js, which reaches for localStorage/fetch/
// document once a mutation commits. Nothing under test here mutates, but stub
// the globals before importing so the module graph is safe regardless of order
// (same rationale as tests/plan-today.test.mjs).
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.fetch = () => Promise.resolve({ json: async () => ({}) });
// NO browser dialogs anywhere in the planner — fail loudly if year.js ever
// reaches for one (this invariant is now planner-wide: subjects.js's Cancel is
// a two-tap button too).
for (const k of ['alert', 'confirm', 'prompt'])
  globalThis[k] = () => { throw new Error(`${k}() must never be called by the planner`); };

const { fmtRange, perName, awayCls, weekAway, nextWorkStart, monthGroups, axisHtml,
        MIN_LABEL_SPAN } = await import('../js/plan/year.js');

// ── fmtRange ────────────────────────────────────────────────
test('fmtRange: collapses the month only when both ends share month AND year', () => {
  assert.equal(fmtRange('2027-01-04', '2027-01-10'), 'Jan 4 – 10');      // same month
  assert.equal(fmtRange('2027-03-05', '2027-03-05'), 'Mar 5 – 5');       // single day
  assert.equal(fmtRange('2027-01-04', '2027-02-06'), 'Jan 4 – Feb 6');   // cross-month
  assert.equal(fmtRange('2026-12-28', '2027-01-03'), 'Dec 28 – Jan 3');  // cross-year
  // Same month NUMBER a year apart must NOT collapse to "Jan 4 – 10".
  assert.equal(fmtRange('2026-01-04', '2027-01-10'), 'Jan 4 – Jan 10');
});

// ── perName ─────────────────────────────────────────────────
test('perName: strips family-typed icons and falls back per type', () => {
  assert.equal(perName({ type: 'travel', label: 'Dhaka ✈' }), 'Dhaka');
  assert.equal(perName({ type: 'off', label: '  ⏸ Winter break ' }), 'Winter break');
  assert.equal(perName({ type: 'travel', label: '' }), 'Time away');
  assert.equal(perName({ type: 'travel' }), 'Time away');
  assert.equal(perName({ type: 'off' }), 'Off');
  assert.equal(perName({ type: 'off', label: '⏸' }), 'Off');   // icon-only label = no label
});

// ── awayCls ─────────────────────────────────────────────────
test('awayCls: 4 classes, majority picks the type, travel wins a tie', () => {
  assert.equal(awayCls({ travel: 0, off: 0, total: 0 }), '');            // school all week
  assert.equal(awayCls({ travel: 7, off: 0, total: 7 }), 'trip');
  assert.equal(awayCls({ travel: 3, off: 0, total: 3 }), 'trip-part');
  assert.equal(awayCls({ travel: 0, off: 7, total: 7 }), 'offw');
  assert.equal(awayCls({ travel: 0, off: 3, total: 3 }), 'offw-part');
  // majority rule across a mixed week
  assert.equal(awayCls({ travel: 2, off: 5, total: 7 }), 'offw');
  assert.equal(awayCls({ travel: 5, off: 2, total: 7 }), 'trip');
  // ties go to travel (the lighter hatch — an off week is the louder claim and
  // should only be drawn when off genuinely dominates)
  assert.equal(awayCls({ travel: 2, off: 2, total: 4 }), 'trip-part');
  assert.equal(awayCls({ travel: 3.5, off: 3.5, total: 7 }), 'trip');
});

// ── weekAway ────────────────────────────────────────────────
const MON = '2026-08-17';                     // a Monday

test('weekAway: splits the 7 days by type and lists the distinct periods', () => {
  const periods = [
    { id: 'p1', start: '2026-08-17', end: '2026-08-19', type: 'travel', label: 'Dhaka' }, // Mon–Wed
    { id: 'p2', start: '2026-08-20', end: '2026-08-20', type: 'off', label: 'Eid' },      // Thu
  ];
  const aw = weekAway(periods, MON);
  assert.equal(aw.travel, 3);
  assert.equal(aw.off, 1);
  assert.equal(aw.total, 4);
  assert.equal(aw.list.length, 2);
  assert.deepEqual(aw.list.map(x => x.id), ['p1', 'p2']);
  assert.equal(awayCls(aw), 'trip-part');
});

test('weekAway: an empty week and a fully covered week', () => {
  assert.deepEqual(weekAway([], MON), { travel: 0, off: 0, total: 0, list: [] });
  const full = weekAway([{ id: 'p1', start: '2026-08-15', end: '2026-08-30', type: 'travel' }], MON);
  assert.equal(full.total, 7);
  assert.equal(full.travel, 7);
  assert.equal(awayCls(full), 'trip');
});

test('weekAway: an off period overlapping a travel one takes those days (off wins)', () => {
  const periods = [
    { id: 'p1', start: '2026-08-17', end: '2026-08-19', type: 'travel', label: 'Dhaka' },
    { id: 'p2', start: '2026-08-18', end: '2026-08-18', type: 'off', label: 'Eid' },
  ];
  const aw = weekAway(periods, MON);
  assert.equal(aw.travel, 2);                 // Mon + Wed only
  assert.equal(aw.off, 1);                    // Tue belongs to the off period
  assert.equal(aw.total, 3);
  assert.deepEqual(aw.list.map(x => x.id).sort(), ['p1', 'p2']);
});

// ── nextWorkStart ───────────────────────────────────────────
// A Charlton stretch runs Tue → Mon from dutyStart, then 7 days off.
const CYCLE = { dutyStart: '2026-08-11' };    // Tue 2026-08-11 .. Mon 2026-08-17

test('nextWorkStart: from a work day it skips to the NEXT stretch, not today', () => {
  // 2026-08-17 is a work day but mid-stretch, so it is not a start.
  assert.equal(nextWorkStart(CYCLE, '2026-08-17'), '2026-08-25');
  assert.equal(nextWorkStart(CYCLE, '2026-08-12'), '2026-08-25');
});

test('nextWorkStart: from a home day it returns the upcoming Tuesday start', () => {
  assert.equal(nextWorkStart(CYCLE, '2026-08-18'), '2026-08-25');   // first home day
  assert.equal(nextWorkStart(CYCLE, '2026-08-24'), '2026-08-25');   // last home day
});

test('nextWorkStart: standing ON a stretch start returns that day', () => {
  assert.equal(nextWorkStart(CYCLE, '2026-08-11'), '2026-08-11');
  assert.equal(nextWorkStart(CYCLE, '2026-08-25'), '2026-08-25');
});

test('nextWorkStart: always resolves inside the 15-day scan (never null)', () => {
  // Every day of a full 14-day cycle must find a start within the window.
  for (let i = 0; i < 14; i++) {
    const from = `2026-09-${String(i + 1).padStart(2, '0')}`;
    assert.notEqual(nextWorkStart(CYCLE, from), null, `no start found from ${from}`);
  }
});

// ── Month axis: crowded part-months lose their label, never their column ──
test('monthGroups: consecutive weeks collapse into one span per calendar month', () => {
  const wks = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'];
  assert.deepEqual(monthGroups(wks), [{ m: 7, n: 1 }, { m: 8, n: 4 }, { m: 9, n: 1 }]);
  assert.deepEqual(monthGroups([]), []);
});

test('axisHtml: a month under MIN_LABEL_SPAN columns keeps its slot but drops its label', () => {
  // 4, not 3: at 390px three columns are ~15px, too little for a 3-letter label.
  assert.equal(MIN_LABEL_SPAN, 4);
  const wks = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05'];
  const html = axisHtml(wks);
  // The alignment grid is unchanged: every group still spans its own weeks.
  assert.match(html, /style="--n:6"/);
  assert.match(html, /<span style="grid-column:span 1"><\/span>/);
  assert.match(html, /<span style="grid-column:span 4">Sep<\/span>/);
  assert.doesNotMatch(html, />Aug</);                    // 1 week at the start
  assert.doesNotMatch(html, />Oct</);                    // 1 week at the end
  // Exactly 4 columns is the threshold; a 3-column month is NOT labelled.
  assert.match(axisHtml(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']), />Nov</);
  const three = axisHtml(['2026-11-02', '2026-11-09', '2026-11-16']);
  assert.doesNotMatch(three, />Nov</);
  assert.match(three, /<span style="grid-column:span 3"><\/span>/);   // slot kept
});
