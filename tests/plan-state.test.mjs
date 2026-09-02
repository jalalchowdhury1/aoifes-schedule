import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedPlan } from '../js/plan/seed.js';
import {
  sanitizePlan, serializePlan, actDone, nextSession, currentCur,
  requiredPerCycle, targetStats, chainTimeline,
} from '../js/plan/model.js';

// state.js touches localStorage / fetch / document at module scope and on every
// commit(). Stub the browser globals BEFORE importing it (dynamic import below).
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.fetch = () => Promise.resolve({ json: async () => ({}) });
globalThis.document = { dispatchEvent: () => {} };
const S = await import('../js/plan/state.js');
const { plan, initPlan, togglePaced, logTimed, logSession, logDailyStatus, addPeriod, updatePeriod, deletePeriod,
        setSlot, onPlanChange } = S;

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
  assert.equal(p.parentCycle.confirmed, true);             // parity checked against the calendar
  assert.equal(p.parentCycle.dutyStart, '2026-08-11');     // Charlton Tue->Mon stretch
  assert.deepEqual(p.periods, []);                         // no invented trip dates
  assert.equal(p.log.length, 1);                           // the known 8/16 LoE lesson
});

test('initPlan sanitizes the seed: v2 invariants on every load path', () => {
  initPlan();
  assert.deepEqual(plan.data.periods, []);
  assert.equal(plan.data.parentCycle.dutyStart, '2026-08-11');
  assert.equal('weeks' in plan.data, false);            // shim removed (Task C)
});

// ── time-away period mutations ──────────────────────────────
test('addPeriod / updatePeriod / deletePeriod round-trip leaves the plan untouched', () => {
  initPlan();
  const before = snap(plan.data);
  assert.deepEqual(plan.data.periods, []);

  const a = addPeriod({ start: '2027-01-04', end: '2027-02-07', type: 'travel', label: 'Dhaka ✈' });
  assert.equal(a.id, 'p1');
  assert.deepEqual(plan.data.periods, [{ id: 'p1', start: '2027-01-04', end: '2027-02-07',
                                         type: 'travel', label: 'Dhaka ✈' }]);
  const b = addPeriod({ start: '2026-12-24', end: '2026-12-26', type: 'off' });
  assert.equal(b.id, 'p2');                                     // id from max, not length
  assert.deepEqual(plan.data.periods.map(p => p.id), ['p2', 'p1']);   // kept sorted by start
  assert.equal(plan.data.periods[0].label, undefined);          // label is optional

  updatePeriod('p1', { end: '2027-01-31', label: 'Dhaka', type: 'off' });
  const edited = plan.data.periods.find(p => p.id === 'p1');
  assert.deepEqual(edited, { id: 'p1', start: '2027-01-04', end: '2027-01-31',
                             type: 'off', label: 'Dhaka' });
  updatePeriod('p1', { label: '' });                            // clearing the label drops the key
  assert.equal('label' in plan.data.periods.find(p => p.id === 'p1'), false);

  deletePeriod('p1');
  deletePeriod('p2');
  assert.deepEqual(snap(plan.data), before);
});

test('period mutations reject junk instead of poisoning the plan', () => {
  initPlan();
  assert.equal(addPeriod({ start: 'zzz', end: '2027-01-05', type: 'travel' }), null);
  assert.equal(addPeriod({ start: '2027-01-05', end: '2027-01-04', type: 'travel' }), null);
  assert.deepEqual(plan.data.periods, []);
  const p = addPeriod({ start: '2027-01-04', end: '2027-01-05', type: 'nonsense' });
  assert.equal(p.type, 'travel');                               // unknown type falls back to travel
  updatePeriod('p1', { start: 'zzz', end: 'zzz', type: 'light' });
  assert.deepEqual(plan.data.periods, [{ id: 'p1', start: '2027-01-04',
                                         end: '2027-01-05', type: 'travel' }]);
  updatePeriod('nope', { end: '2027-02-01' });                  // unknown id -> no-op
  deletePeriod('nope');
  assert.equal(plan.data.periods.length, 1);
  deletePeriod('p1');
  assert.deepEqual(plan.data.periods, []);
});

// Week marking and the anchor flip are gone with the Year page rewrite (Task B).
// Guard the removal: a stray re-export would mean a view can still mutate weeks.
test('setWeekType / flipAnchor are gone from the store', () => {
  assert.equal('setWeekType' in S, false);
  assert.equal('flipAnchor' in S, false);
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

// ── logTimed: bot-interop keys (planner-v2.4) ───────────────
// A Telegram-written one-off has no activityId; its override `id` doubles as
// the eventId, so a website tap must write that same shape. A call with
// NEITHER key is refused: the row would have nothing to find it by, and
// match()'s activityId branch would then compare `undefined === undefined`
// against every other keyless timed entry on the date.
test('logTimed: an override id logs as an eventId, toggles off, and refuses ownerless writes', () => {
  initPlan();
  const rows = () => plan.data.log.filter(e => e.date === D);
  logTimed('x1', null, 'done', D);
  assert.deepEqual(rows(), [{ date: D, status: 'done', timed: true, eventId: 'x1' }]);
  logTimed('x1', null, 'done', D);                    // same status again -> toggle off
  assert.deepEqual(rows(), []);

  const before = snap(plan.data);
  logTimed(null, null, 'done', D);                    // no key at all -> nothing written
  assert.deepEqual(rows(), []);
  assert.deepEqual(snap(plan.data), before);
});

// ── logDailyStatus: the phone's long-press "skipped" write (planner-v2.9,
// item D) — the desktop has no daily-missed control, so this is new, not a
// wrapper. Must write the bot's own marker shape and never touch a `done`
// row that carries a `curriculum`.
test('logDailyStatus: writes the bot\'s exact marker shape, toggles off on a repeat tap', () => {
  initPlan();
  const rows = () => plan.data.log.filter(e => e.date === D && e.activityId === 'loe');
  logDailyStatus('loe', 'missed', D);
  assert.deepEqual(rows(), [{ date: D, activityId: 'loe', status: 'missed' }]);
  logDailyStatus('loe', 'missed', D);                 // same status again -> toggle off
  assert.deepEqual(rows(), []);
});

test('logDailyStatus: a repeat tap with a DIFFERENT status overwrites in place, not a second row', () => {
  initPlan();
  logDailyStatus('loe', 'missed', D);
  logDailyStatus('loe', 'partial', D);
  const rows = plan.data.log.filter(e => e.date === D && e.activityId === 'loe');
  assert.deepEqual(rows, [{ date: D, activityId: 'loe', status: 'partial' }]);
});

// review 2: the ORIGINAL version of this test asserted that a done row and a
// new marker were left to coexist (two rows, one date/activity). That was
// the bug — dailyStatus/item_status give a marker priority over a done row
// (by design, for a marker written FIRST), so once a marker existed on top
// of real work, the day would read 'missed' even though a session had
// genuinely been logged and its curriculum counter advanced. Fixed to match
// the bot's guard_missed_tap: a marker write is refused outright while a
// done row already exists that day, generalized to every daily pattern (see
// logDailyStatus's own comment for why the guard goes further than the
// bot's tb-wb-only backend check).
test('logDailyStatus: refuses to write a marker over a real logged session row (guard_missed_tap parity)', () => {
  initPlan();
  togglePaced('loe', D);                              // a real, curriculum-bearing session log
  const before = snap(plan.data);
  const result = logDailyStatus('loe', 'missed', D);
  assert.equal(result, false);
  assert.deepEqual(snap(plan.data), before);          // no marker, no commit, chain untouched
  const rows = plan.data.log.filter(e => e.date === D && e.activityId === 'loe');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'done');
});

test('logDailyStatus: an EXISTING marker can still be toggled off even if a done row also exists (legacy data)', () => {
  initPlan();
  const act = plan.data.activities.find(a => a.id === 'loe');
  act.chain[0].done = 5;
  plan.data.log.push(
    { date: D, activityId: 'loe', status: 'done', curriculum: act.chain[0].id, session: 5 },
    { date: D, activityId: 'loe', status: 'missed' },   // pre-existing collision, e.g. from before this fix
  );
  const result = logDailyStatus('loe', 'missed', D);    // same status -> toggling the marker off is always safe
  assert.equal(result, true);
  const rows = plan.data.log.filter(e => e.date === D && e.activityId === 'loe');
  assert.deepEqual(rows, [{ date: D, activityId: 'loe', status: 'done', curriculum: act.chain[0].id, session: 5 }]);
});

test('logDailyStatus: unknown activity id is a silent no-op', () => {
  initPlan();
  const before = snap(plan.data);
  logDailyStatus('nonsense', 'missed', D);
  assert.deepEqual(snap(plan.data), before);
});

// ── sanitize date guards + walk caps (I2) ───────────────────
test('sanitizePlan: malformed dates fall back to defaults and bad rows are dropped', () => {
  const p = sanitizePlan({
    year: { label: 'bad', start: '2026-08-17', end: 'zzz' },
    parentCycle: { pattern: '7on7off', anchorMonday: 'nope', confirmed: true },
    weeks: { 'zzz': { type: 'travel' }, '2026-12-21': { type: 'travel' } },
    periods: [{ id: 'p1', start: 'zzz', end: '2027-01-05', type: 'travel' },
              { id: 'p2', start: '2027-01-04', end: '2027-01-05', type: 'travel' }],
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
  assert.equal(p.parentCycle.dutyStart, '2026-08-11');    // ISO-validated default
  assert.deepEqual(p.periods.map(x => x.id), ['w-2026-12-21', 'p2']);  // bad period dropped, week migrated
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

test('setBaseline freezes unfinished row dates; complete rows excluded; overwrite works', () => {
  plan.data = sanitizePlan({
    parentCycle: { anchorMonday: '2026-08-24', dutyStart: '2026-08-11' },
    activities: [{ id: 'sm', type: 'paced', status: 'active',
      rhythm: { kind: 'daily' }, travel: { mode: 'reduced', factor: 0.5 },
      chain: [
        { id: 'c1', pattern: 'tb-wb', lessons: 3, tests: 0, done: 6 },   // complete
        { id: 'c2', pattern: 'tb-wb', lessons: 2, tests: 1, done: 0 },
      ] }],
  });
  S.setBaseline('sm', '2026-09-01');
  const act = plan.data.activities[0];
  assert.equal(act.baseline.setOn, '2026-09-01');
  assert.equal('c1' in act.baseline.rows, false);            // complete: history, not plan
  const expected = chainTimeline(act, '2026-09-01', plan.data).find(r => r.key === 'c2').finish;
  assert.equal(act.baseline.rows.c2, expected);
  S.setBaseline('sm', '2026-09-08');                          // re-baseline overwrites
  assert.equal(act.baseline.setOn, '2026-09-08');
  const before = plan.data.savedAt;
  assert.equal(S.setBaseline('nope'), undefined);             // unknown id: no throw
  assert.equal(plan.data.savedAt, before);                    // and no commit/save
});

// ── logSession / unlogSessionsFrom (multi-session days) ──────
// The phone's Singapore card used to drive BOTH its "✓ Textbook" and
// "✓ Workbook" buttons through togglePaced, which is a TOGGLE keyed on
// (activity, date): the workbook tap found the textbook tap's row and
// REMOVED it, so a lesson could never be more than half logged and a second
// lesson the same day was impossible (reported from a real phone screen,
// 2026-08-31). These two paths are the append / append-inverse pair the card
// writes through instead — same row shape the Telegram bot's
// `_apply_log_progress` writes, one log row per session.
const SM = () => {
  initPlan();
  const sm = plan.data.activities.find(a => a.id === 'singapore');
  sm.status = 'active';
  sm.chain = [
    { id: 'dm3-c1', name: '3A Ch 1 · Numbers to 10,000', pattern: 'tb-wb', lessons: 11, tests: 0, done: 10 },
    { id: 'dm3-c2', name: '3A Ch 2 · Addition and Subtraction', pattern: 'tb-wb', lessons: 8, tests: 1, done: 0 },
  ];
  return sm;
};
const c1 = () => curOf(plan.data, 'singapore', 'dm3-c1');
const c2 = () => curOf(plan.data, 'singapore', 'dm3-c2');
const smRows = (date = D) => plan.data.log.filter(e =>
  e.activityId === 'singapore' && e.date === date && e.status === 'done');

test('logSession: two taps the same day are TWO sessions, never a toggle', () => {
  SM();
  const { logSession } = S;
  logSession('singapore', D);
  logSession('singapore', D);
  assert.equal(c1().done, 12);                                  // L6 textbook + workbook
  assert.deepEqual(smRows().map(e => e.session), [10, 11]);
  assert.deepEqual(smRows().map(e => e.curriculum), ['dm3-c1', 'dm3-c1']);
});

test('logSession: rolls into the next chapter when the current one runs out', () => {
  SM();
  const { logSession } = S;
  c1().done = 21;                                  // one session left in Ch 1
  logSession('singapore', D);
  logSession('singapore', D);
  assert.equal(c1().done, 22);
  assert.equal(c2().done, 1);
  assert.deepEqual(smRows().map(e => e.curriculum), ['dm3-c1', 'dm3-c2']);
});

test('logSession: an exhausted chain writes nothing at all', () => {
  SM();
  const { logSession } = S;
  c1().done = 22; c2().done = 17;
  const before = snap(plan.data);
  assert.equal(logSession('singapore', D), null);
  assert.deepEqual(snap(plan.data), before);
});

test('unlogSessionsFrom: log then unlog is the identity', () => {
  SM();
  const { logSession, unlogSessionsFrom } = S;
  const before = snap(plan.data);
  logSession('singapore', D);
  logSession('singapore', D);
  const removed = unlogSessionsFrom('singapore', 'dm3-c1', 10, D);
  assert.equal(removed.length, 2);
  assert.deepEqual(removed.map(e => e.session), [10, 11]);      // teaching order, replayable
  assert.deepEqual(snap(plan.data), before);
});

test('unlogSessionsFrom: takes the halves ABOVE it too — a session only comes off the top', () => {
  SM();
  const { logSession, unlogSessionsFrom } = S;
  logSession('singapore', D);                                   // L6 textbook
  logSession('singapore', D);                                   // L6 workbook
  logSession('singapore', D);                                   // L7 textbook
  const removed = unlogSessionsFrom('singapore', 'dm3-c1', 11, D);
  assert.deepEqual(removed.map(e => e.session), [11, 12]);
  assert.equal(c1().done, 11);                                  // L6 textbook survives
  assert.deepEqual(smRows().map(e => e.session), [10]);
});

test('unlogSessionsFrom: never touches another DAY, however recent', () => {
  SM();
  const { logSession, unlogSessionsFrom } = S;
  logSession('singapore', '2026-08-31');                        // yesterday: L6 textbook
  logSession('singapore', D);                                   // today: L6 workbook
  const removed = unlogSessionsFrom('singapore', 'dm3-c1', 11, D);
  assert.deepEqual(removed.map(e => e.session), [11]);
  assert.equal(c1().done, 11);
  assert.equal(smRows('2026-08-31').length, 1);                 // yesterday intact
});

test('unlogSessionsFrom: crosses a chapter boundary upward, rolling BOTH counters back', () => {
  SM();
  const { logSession, unlogSessionsFrom } = S;
  c1().done = 21;
  logSession('singapore', D);                                   // finishes Ch 1
  logSession('singapore', D);                                   // Ch 2, session 0
  const removed = unlogSessionsFrom('singapore', 'dm3-c1', 21, D);
  assert.equal(removed.length, 2);
  assert.equal(c1().done, 21);
  assert.equal(c2().done, 0);
});

test('unlogSessionsFrom: an unknown chapter id is refused, not guessed', () => {
  SM();
  const { logSession, unlogSessionsFrom } = S;
  logSession('singapore', D);
  const before = snap(plan.data);
  assert.deepEqual(unlogSessionsFrom('singapore', 'nope', 0, D), []);
  assert.deepEqual(snap(plan.data), before);
});

test('unlogSessionsFrom: leaves a ✗ marker and a timed row for that day alone', () => {
  SM();
  const { logSession, unlogSessionsFrom } = S;
  logSession('singapore', D);
  plan.data.log.push({ date: D, activityId: 'singapore', status: 'missed' });
  plan.data.log.push({ date: D, activityId: 'singapore', status: 'done', timed: true });
  unlogSessionsFrom('singapore', 'dm3-c1', 10, D);
  const left = plan.data.log.filter(e => e.date === D && e.activityId === 'singapore');
  assert.equal(left.length, 2);
  assert.ok(left.some(e => e.status === 'missed'));
  assert.ok(left.some(e => e.timed));
});

// ── Out-of-order sessions: writers go through the primitives (spec 2026-09-01) ──
test('logSession writes the lowest OWED slot first', () => {
  SM();
  const { logSession } = S;
  c1().done = 14; c1().skipped = [12, 13];
  const e = logSession('singapore', D);
  assert.equal(e.session, 12);
  assert.deepEqual([c1().done, c1().skipped], [15, [13]]);
});

test('unlogSessionsFrom rolls back through unmarkSession', () => {
  SM();
  const { unlogSessionsFrom } = S;
  c1().done = 14; c1().skipped = [12, 13];
  plan.data.log.push({ date: D, activityId: 'singapore', status: 'done', curriculum: 'dm3-c1', session: 14 });
  plan.data.log.push({ date: D, activityId: 'singapore', status: 'done', curriculum: 'dm3-c1', session: 15 });
  const removed = unlogSessionsFrom('singapore', 'dm3-c1', 14, D);
  assert.deepEqual(removed.map(r => r.session), [14, 15]);
  assert.deepEqual([c1().done, c1().skipped ?? null], [12, null]);
});

test('togglePaced uncheck unmarks the exact session of the removed row', () => {
  SM();
  c1().done = 14; c1().skipped = [12, 13];
  plan.data.log.push({ date: D, activityId: 'singapore', status: 'done', curriculum: 'dm3-c1', session: 15 });
  togglePaced('singapore', D);
  assert.deepEqual([c1().done, c1().skipped], [13, [12, 13]]);
});


test('setSlot: patches one slot in place, keeps (actId, idx) identity, and commits', () => {
  initPlan();
  const geo = plan.data.activities.find(a => a.id === 'geography');
  geo.status = 'active'; geo.onGrid = true;
  geo.slots = [{ day: 2, start: 11, end: 12 }, { day: 4, start: 9, end: 10 }];
  let fired = 0; onPlanChange(() => fired++);
  const before = plan.data.savedAt;
  assert.equal(setSlot('geography', 0, { day: 3, start: 13, end: 14 }), true);
  assert.deepEqual(geo.slots, [{ day: 3, start: 13, end: 14 }, { day: 4, start: 9, end: 10 }]);
  assert.equal(fired, 1);
  assert.notEqual(plan.data.savedAt, before);             // savePlan stamped it
});

test('setSlot: a partial patch only touches the given fields', () => {
  initPlan();
  const geo = plan.data.activities.find(a => a.id === 'geography');
  geo.slots = [{ day: 2, start: 11, end: 12 }];
  setSlot('geography', 0, { end: 12.5 });
  assert.deepEqual(geo.slots, [{ day: 2, start: 11, end: 12.5 }]);
});

test('setSlot: unknown activity / index → false, no commit; non-numeric values are ignored but still commit', () => {
  initPlan();
  const geo = plan.data.activities.find(a => a.id === 'geography');
  geo.slots = [{ day: 2, start: 11, end: 12 }];
  const before = snap(plan.data);
  let fired = 0; onPlanChange(() => fired++);
  assert.equal(setSlot('nope', 0, { day: 1 }), false);
  assert.equal(setSlot('geography', 5, { day: 1 }), false);
  assert.equal(setSlot('geography', 0, { day: '1', start: null }), true);   // accepted, but nothing numeric to apply
  assert.deepEqual(snap(plan.data), before);
  assert.equal(fired, 1);                                   // the third call still commits (a no-op patch is not an error)
});

// ── logTimed on a paced on-grid class: attendance ⇒ next lesson (2026-09-01) ──
function armGeography() {
  initPlan();
  const geo = plan.data.activities.find(a => a.id === 'geography');
  geo.status = 'active'; geo.onGrid = true; geo.type = 'paced';
  geo.slots = [{ day: 1, start: 11, end: 12 }];
  geo.chain = [{ id: 'geo-1', name: 'Year 1', pattern: 'simple', firstUnit: 1, lastUnit: 30, done: 0,
                 unitWord: 'Week', titles: { '1': 'Introduction to Geography' } }];
  return geo;
}
const geoRows = () => plan.data.log.filter(e => e.date === D && e.activityId === 'geography');

test('logTimed: ✓ on a paced on-grid class writes attendance AND its next lesson', () => {
  const geo = armGeography();
  logTimed(null, 'geography', 'done', D);
  assert.deepEqual(geoRows(), [
    { date: D, status: 'done', timed: true, activityId: 'geography' },
    { date: D, activityId: 'geography', status: 'done', curriculum: 'geo-1', session: 0, viaTimed: true },
  ]);
  assert.equal(geo.chain[0].done, 1);
});

// ── logTimed: viaTimed provenance closes the ✓ loop (red-team H1) ──────────
test('logTimed: ✓ when a lesson row for that day already exists writes attendance only, no double-count', () => {
  const geo = armGeography();
  logSession('geography', D);                              // e.g. logged via the Subjects sheet first
  assert.equal(geo.chain[0].done, 1);
  logTimed(null, 'geography', 'done', D);
  assert.deepEqual(geoRows(), [
    { date: D, activityId: 'geography', status: 'done', curriculum: 'geo-1', session: 0 },
    { date: D, status: 'done', timed: true, activityId: 'geography' },
  ]);
  assert.equal(geo.chain[0].done, 1);                       // unchanged: no second lesson appended
});

test('logTimed: untick after a second, foreign lesson row removes only the viaTimed row', () => {
  const geo = armGeography();
  logTimed(null, 'geography', 'done', D);                   // writes attendance + viaTimed lesson (session 0)
  logSession('geography', D);                                // a second, foreign lesson the same day (session 1)
  assert.equal(geo.chain[0].done, 2);
  logTimed(null, 'geography', 'done', D);                   // untick
  assert.deepEqual(geoRows(), [
    { date: D, activityId: 'geography', status: 'done', curriculum: 'geo-1', session: 1 },
  ]);
  assert.equal(geo.chain[0].done, 1);                        // only the viaTimed session rolled back
});

test('logTimed: untick when the only lesson row that day is not viaTimed touches nothing', () => {
  const geo = armGeography();
  logSession('geography', D);                                // seed a foreign lesson row first
  logTimed(null, 'geography', 'done', D);                    // per the guard above: attendance only, no new lesson
  assert.equal(geo.chain[0].done, 1);
  logTimed(null, 'geography', 'done', D);                    // untick the attendance row
  assert.deepEqual(geoRows(), [
    { date: D, activityId: 'geography', status: 'done', curriculum: 'geo-1', session: 0 },
  ]);
  assert.equal(geo.chain[0].done, 1);                        // the non-viaTimed lesson is never touched
});

test('logTimed: tapping ✓ again (toggle off) removes the lesson and restores done', () => {
  const geo = armGeography();
  logTimed(null, 'geography', 'done', D);
  logTimed(null, 'geography', 'done', D);
  assert.deepEqual(geoRows(), []);
  assert.equal(geo.chain[0].done, 0);
});

test('logTimed: done → missed rolls the lesson back; missed → done advances again', () => {
  const geo = armGeography();
  logTimed(null, 'geography', 'done', D);
  logTimed(null, 'geography', 'missed', D);
  assert.deepEqual(geoRows(), [{ date: D, status: 'missed', timed: true, activityId: 'geography' }]);
  assert.equal(geo.chain[0].done, 0);
  logTimed(null, 'geography', 'done', D);
  assert.equal(geo.chain[0].done, 1);
  assert.equal(geoRows().length, 2);
});

test('logTimed: partial never advances; an exhausted chain writes attendance only', () => {
  const geo = armGeography();
  logTimed(null, 'geography', 'partial', D);
  assert.equal(geo.chain[0].done, 0);
  assert.equal(geoRows().length, 1);
  initPlan();
  const g2 = armGeography();
  g2.chain[0].done = 30;                                   // every session done
  logTimed(null, 'geography', 'done', D);
  assert.deepEqual(geoRows(), [{ date: D, status: 'done', timed: true, activityId: 'geography' }]);
  assert.equal(g2.chain[0].done, 30);
});

test('logTimed: untick only takes back THAT day\'s lesson, never an earlier day\'s', () => {
  const geo = armGeography();
  logTimed(null, 'geography', 'done', '2026-08-25');       // last week's class
  logTimed(null, 'geography', 'done', D);
  assert.equal(geo.chain[0].done, 2);
  logTimed(null, 'geography', 'done', D);                  // untick today
  assert.equal(geo.chain[0].done, 1);
  assert.equal(plan.data.log.filter(e => e.activityId === 'geography' && e.curriculum).length, 1);
  assert.equal(plan.data.log.find(e => e.activityId === 'geography' && e.curriculum).date, '2026-08-25');
});

test('logTimed: a template event and a target activity are untouched by the lesson rule', () => {
  armGeography();
  const jj = plan.data.activities.find(a => a.id === 'jj');
  jj.status = 'active'; jj.onGrid = true; jj.slots = [{ day: 0, start: 16, end: 17 }];
  logTimed('e1003', null, 'done', D);
  logTimed(null, 'jj', 'done', D);
  assert.deepEqual(plan.data.log.filter(e => e.date === D), [
    { date: D, status: 'done', timed: true, eventId: 'e1003' },
    { date: D, status: 'done', timed: true, activityId: 'jj' },
  ]);
});

test('togglePaced after a ✓ on an on-grid class (the phone\'s Oops) removes the LESSON row, never the attendance row', () => {
  const geo = armGeography();
  logTimed(null, 'geography', 'done', D);
  assert.equal(geo.chain[0].done, 1);
  togglePaced('geography', D);
  assert.deepEqual(geoRows(), [{ date: D, status: 'done', timed: true, activityId: 'geography' }]);
  assert.equal(geo.chain[0].done, 0);
});
