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
        MIN_LABEL_SPAN, coreRows, shortName, weekAttHtml, historyRows, HISTORY_CAP } = await import('../js/plan/year.js');
const { store } = await import('../js/state.js');
const { plan } = await import('../js/plan/state.js');
const { todayStr, addDays } = await import('../js/plan/model.js');

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

// ── Core attendance rows (per-subject, replaces the old synthetic Core row) ──
// The rows are DERIVED from the template, so a category with no recurring
// blocks (Art, Mama Classes) never gets one and no second list has to be kept.
const ACTS = [
  { id: 'core-ruhamah', type: 'ongoing', status: 'active', cat: 'ruhamah', cls: 'r' },
  { id: 'core-hala',    type: 'ongoing', status: 'active', cat: 'hala',    cls: 'h' },
  { id: 'core-quran',   type: 'ongoing', status: 'active', cat: 'quran',   cls: 'q' },
  { id: 'core-art',     type: 'ongoing', status: 'active', cat: 'art',     cls: 'a' },
  { id: 'core-mama',    type: 'ongoing', status: 'active', cat: 'barakot', cls: 'b' },
  { id: 'loe',   name: 'Logic of English', type: 'paced', status: 'active', cls: 'b' },
  { id: 'gone',  type: 'ongoing', status: 'parked', cat: 'quran', cls: 'q' },
];
const EVENTS = [
  { id: 'e999' },                                          // the corrupt live record
  { id: 'q1', cat: 'quran', day: 0, start: 10, end: 11 },
  { id: 'q3', cat: 'quran', day: 2, start: 10, end: 11 },
  { id: 'q5', cat: 'quran', day: 4, start: 10, end: 11 },
  { id: 'r1', cat: 'ruhamah', day: 0, start: 11, end: 13 },
  { id: 'r2', cat: 'ruhamah', day: 1, start: 11, end: 12 },
  { id: 'h2', cat: 'hala', day: 1, start: 14, end: 15 },
];

test('coreRows: active ongoing activities whose category is actually on the grid', () => {
  const rows = coreRows(ACTS, EVENTS).map(a => a.id);
  // Art and Mama Classes have no recurring blocks in this template, so no row;
  // a paced subject belongs to the progress tracks, not here; parked is out.
  assert.deepEqual(rows, ['core-ruhamah', 'core-hala', 'core-quran']);
  // Put an Art block on the grid and its row appears — no code change needed.
  assert.deepEqual(
    coreRows(ACTS, [...EVENTS, { id: 'a1', cat: 'art', day: 4, start: 15, end: 16 }]).map(a => a.id),
    ['core-ruhamah', 'core-hala', 'core-quran', 'core-art']);
  // Empty / malformed inputs are rows-less, never a throw.
  assert.deepEqual(coreRows(ACTS, []), []);
  assert.deepEqual(coreRows(null, EVENTS), []);
  assert.deepEqual(coreRows(ACTS, null), []);
});

test('shortName: the part before the em dash, whole name when there is none', () => {
  assert.equal(shortName('Ruhama — ELA/Math'), 'Ruhama');
  assert.equal(shortName('Miss Hala — Arabic/Islamic Studies'), 'Miss Hala');
  assert.equal(shortName('Quran'), 'Quran');
  // Never returns an empty label: a name with nothing before the dash keeps
  // the whole string rather than collapsing to a nameless row.
  assert.equal(shortName('— Nothing before it'), '— Nothing before it');
  assert.equal(shortName(''), '');
});

// ── The info card's attendance line ─────────────────────────
const WK = '2026-08-17';                       // a Monday
const ok = (date, eventId) => ({ date, eventId, status: 'done', timed: true });
const setup = (over = {}) => {
  store.events = EVENTS;
  store.catLabels = {};
  plan.data = { year: { label: 'y', start: WK, end: '2027-08-31' },
                activities: ACTS, periods: [], overrides: [], log: [], ...over };
};

test('weekAttHtml: one "subject done/expected" per core row, in track order', () => {
  setup({ log: [ok('2026-08-17', 'r1'), ok('2026-08-18', 'r2'), ok('2026-08-17', 'q1')] });
  assert.equal(weekAttHtml(WK, '2026-08-18'),
    '<div class="pmeta">Ruhama 2/2 · Miss Hala 0/1 · Quran 1/3</div>');
});

test('weekAttHtml: a week that has not happened yet says nothing', () => {
  setup({ log: [] });
  assert.equal(weekAttHtml('2026-08-24', '2026-08-18'), '');
  // The CURRENT week counts as begun, even on its Monday.
  assert.match(weekAttHtml(WK, WK), /Quran 0\/3/);
});

test('weekAttHtml: away days shrink the denominators, a full week away drops the line', () => {
  setup({ periods: [{ id: 'p1', start: '2026-08-17', end: '2026-08-18', type: 'travel' }],
          log: [ok('2026-08-19', 'q3')] });
  // Mon+Tue gone: Ruhama and Hala have nothing left this week and drop out,
  // and Quran is down to Wed+Fri, of which only Wednesday was ticked.
  assert.equal(weekAttHtml(WK, '2026-08-21'), '<div class="pmeta">Quran 1/2</div>');
  setup({ periods: [{ id: 'p2', start: '2026-08-15', end: '2026-08-30', type: 'off' }] });
  assert.equal(weekAttHtml(WK, '2026-08-21'), '');
  plan.data = null;
  assert.equal(weekAttHtml(WK, '2026-08-21'), '');
});

// ── historyRows (Year per-subject drill-down, planner-v2.8) ──
const TODAY = todayStr();
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
// The first of the month N months before today — day-of-month fixed at 1 so
// the arithmetic never has to worry about a target month being shorter than
// today's day-of-month (no Feb 30).
function monthsAgo(n) {
  const [y, m] = TODAY.split('-').map(Number);
  const total = y * 12 + (m - 1) - n;
  const yy = Math.floor(total / 12), mm = ((total % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
}

test('historyRows: newest-first, grouped by month with This month / Last month / full "Month YYYY" headers', () => {
  const act = { id: 'loe', chain: [{ id: 'loe-c', pattern: 'simple', firstUnit: 101, lastUnit: 120, done: 5 }] };
  const lastMonthDate = monthsAgo(1);
  const olderDate = monthsAgo(3);
  const p = { overrides: [], log: [
    { date: TODAY, activityId: 'loe', status: 'done', curriculum: 'loe-c', session: 4 },
    { date: lastMonthDate, activityId: 'loe', status: 'done', curriculum: 'loe-c', session: 3 },
    { date: olderDate, activityId: 'loe', status: 'partial', curriculum: 'loe-c', session: 2 },
  ] };
  const groups = historyRows(act, [], p);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].monthLabel, 'This month');
  assert.equal(groups[0].rows[0].date, TODAY);
  assert.equal(groups[1].monthLabel, 'Last month');
  assert.equal(groups[1].rows[0].date, lastMonthDate);
  const [y, m] = olderDate.split('-').map(Number);
  assert.equal(groups[2].monthLabel, `${MONTH_FULL[m - 1]} ${y}`);
  assert.equal(groups[2].rows[0].status, 'partial');
});

test('historyRows: rows sort newest-first, including multiple rows within the same month group', () => {
  const act = { id: 'loe', chain: [{ id: 'loe-c', pattern: 'simple', firstUnit: 101, lastUnit: 120, done: 5 }] };
  const d1 = monthsAgo(2), d2 = addDays(d1, 5), d3 = addDays(d1, 10);   // all inside the same month
  const p = { overrides: [], log: [
    { date: d1, activityId: 'loe', status: 'done' },
    { date: d3, activityId: 'loe', status: 'done' },
    { date: d2, activityId: 'loe', status: 'done' },
  ] };
  const groups = historyRows(act, [], p);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].rows.map(r => r.date), [d3, d2, d1]);
});

test('historyRows: a timed row (template event) carries a time range; a paced row carries the session label', () => {
  const events = [{ id: 'q1', cat: 'quran', day: 0, start: 15.5, end: 16.5 }];
  const coreAct = { id: 'core-quran', cat: 'quran', chain: [] };
  const timedGroups = historyRows(coreAct, events,
    { overrides: [], log: [{ date: TODAY, eventId: 'q1', status: 'done', timed: true }] });
  assert.equal(timedGroups[0].rows[0].timeLabel, '3:30pm–4:30pm');
  assert.match(timedGroups[0].rows[0].dayLabel, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \w{3} \d{1,2}$/);
  assert.equal('sessionLabel' in timedGroups[0].rows[0], false);

  const pacedAct = { id: 'loe', chain: [{ id: 'loe-c', name: 'Foundations C', pattern: 'simple',
    firstUnit: 101, lastUnit: 120, done: 5 }] };
  const pacedGroups = historyRows(pacedAct, [],
    { overrides: [], log: [{ date: TODAY, activityId: 'loe', status: 'done', curriculum: 'loe-c', session: 1 }] });
  assert.equal(pacedGroups[0].rows[0].sessionLabel, 'Lesson 102');
  assert.equal('timeLabel' in pacedGroups[0].rows[0], false);
});

test('historyRows: an explicit row.label wins over sessionLabel(chain, session)', () => {
  const act = { id: 'loe', chain: [{ id: 'loe-c', pattern: 'simple', firstUnit: 101, lastUnit: 120, done: 5 }] };
  const p = { overrides: [], log: [{ date: TODAY, activityId: 'loe', status: 'done',
    curriculum: 'loe-c', session: 1, label: 'Lesson 99 (pre-tracking)' }] };
  assert.equal(historyRows(act, [], p)[0].rows[0].sessionLabel, 'Lesson 99 (pre-tracking)');
});

test('historyRows: rows are owned by activityId, a template eventId for the category, or a bot one-off mapped to the activity — never an unrelated row', () => {
  const events = [
    { id: 'e999' },                                      // the corrupt live record — never owned
    { id: 'r1', cat: 'ruhamah', day: 0, start: 11, end: 12 },
  ];
  const act = { id: 'core-ruhamah', cat: 'ruhamah', chain: [] };
  const p = {
    overrides: [
      { date: TODAY, action: 'add', id: 'x1', activityId: 'core-ruhamah', name: 'Makeup Ruhama', start: 15, end: 16 },
      { date: TODAY, action: 'add', id: 'x2', activityId: 'loe', name: 'Unrelated makeup', start: 9, end: 10 },
    ],
    log: [
      { date: TODAY, eventId: 'r1', status: 'done', timed: true },     // template event -> owned
      { date: TODAY, eventId: 'x1', status: 'done', timed: true },     // bot one-off mapped here -> owned
      { date: TODAY, eventId: 'x2', status: 'done', timed: true },     // mapped to a DIFFERENT activity -> not owned
      { date: TODAY, activityId: 'loe', status: 'done' },              // a different activity entirely -> not owned
      { date: TODAY, eventId: 'e999', status: 'done', timed: true },   // corrupt record -> never owned
    ],
  };
  const groups = historyRows(act, events, p);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rows.length, 2);
  assert.deepEqual(groups[0].rows.map(r => r.timeLabel).sort(), ['11am–12pm', '3pm–4pm']);
});

test('historyRows: a null/undefined activity cat never matches the corrupt {id:"e999"} template record', () => {
  const events = [{ id: 'e999' }];
  const act = { id: 'weird', cat: undefined, chain: [] };
  const p = { overrides: [], log: [{ date: TODAY, eventId: 'e999', status: 'done', timed: true }] };
  assert.deepEqual(historyRows(act, events, p), []);
});

test('historyRows: malformed/missing inputs never throw', () => {
  assert.deepEqual(historyRows(null, [], {}), []);
  assert.deepEqual(historyRows({ id: 'a' }, null, null), []);
  assert.deepEqual(historyRows({ id: 'a' }, [], { log: 'garbage', overrides: 'garbage' }), []);
});

// ── HISTORY_CAP: bound a multi-year log (review fix) ──────────
test('historyRows: caps at the most recent HISTORY_CAP rows and appends a muted "…older sessions" notice', () => {
  assert.equal(HISTORY_CAP, 200);
  const act = { id: 'loe', chain: [{ id: 'loe-c', pattern: 'simple', firstUnit: 101, lastUnit: 120, done: 0 }] };
  const base = addDays(TODAY, -400);          // far enough back that nothing collides with "This/Last month"
  const log = Array.from({ length: 250 }, (_, i) => ({ date: addDays(base, i), activityId: 'loe', status: 'done' }));
  const groups = historyRows(act, [], { overrides: [], log });

  const realRows = groups.flatMap(g => g.rows).filter(r => !r.notice);
  assert.equal(realRows.length, 200);
  const notices = groups.flatMap(g => g.rows).filter(r => r.notice);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].label, '…older sessions not shown (50 more)');
  // the notice sits at the very end of the very last (oldest) group
  const lastGroup = groups[groups.length - 1];
  assert.equal(lastGroup.rows[lastGroup.rows.length - 1].notice, true);

  // the 200 most RECENT dates survive (base+50 .. base+249); the oldest 50
  // (base .. base+49) are dropped entirely, not just hidden.
  const keptDates = new Set(realRows.map(r => r.date));
  for (let i = 0; i < 50; i++) assert.equal(keptDates.has(addDays(base, i)), false, `day ${i} should be dropped`);
  for (let i = 50; i < 250; i++) assert.equal(keptDates.has(addDays(base, i)), true, `day ${i} should survive`);
});

test('historyRows: under the cap, no notice row is added anywhere', () => {
  const act = { id: 'loe', chain: [{ id: 'loe-c', pattern: 'simple', firstUnit: 101, lastUnit: 120, done: 0 }] };
  const log = Array.from({ length: 5 }, (_, i) => ({ date: addDays(TODAY, -i), activityId: 'loe', status: 'done' }));
  const groups = historyRows(act, [], { overrides: [], log });
  assert.equal(groups.flatMap(g => g.rows).length, 5);
  assert.ok(!groups.flatMap(g => g.rows).some(r => r.notice));
});
