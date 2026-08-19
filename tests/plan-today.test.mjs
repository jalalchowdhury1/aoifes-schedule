import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayStr, addDays, dayIdx, sanitizePlan, isWorkDay } from '../js/plan/model.js';

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
  constructor() { this._html = ''; this._text = ''; }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = v; }
  get textContent() { return this._text; }
  querySelectorAll() { return []; }
}
const viewToday = new FakeEl();
// The freshness caption is patched in place between full renders (paintSynced),
// so the stub has to serve that one node too.
const psync = new FakeEl();
globalThis.document = {
  getElementById: id => (id === 'view-today' ? viewToday : id === 'psync' ? psync : null),
  dispatchEvent: () => {},
};

const { store } = await import('../js/state.js');
const { plan } = await import('../js/plan/state.js');
const { markSynced, syncInfo } = await import('../js/sync.js');
// The caption reports the OLDER of the two blobs' rounds, so a test that wants
// a specific clock time marks BOTH stores at it.
const bothSyncedAt = at => { syncInfo.plan = at; syncInfo.schedule = at; };
const { renderToday, fmtUntil, dailyVisible, thisWeekHtml, yesterdayHtml,
        syncedCaption, paintSynced } = await import('../js/plan/today.js');

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
  // 2026-08-11 is the real dutyStart in prod (see loadPlan's parentCycle);
  // derive the expected chip from the same model the app uses rather than
  // pinning it to a specific weekday, so this test stays green every day.
  const expected = isWorkDay({ dutyStart: '2026-08-11' }, TODAY) ? 'Mama: work day' : 'Mama: home day';
  const other = expected === 'Mama: work day' ? 'Mama: home day' : 'Mama: work day';
  assert.match(html, new RegExp(expected));
  assert.doesNotMatch(html, new RegExp(other));
  assert.match(html, /class="tblock/);
  assert.match(html, /Quran reading/);
  assert.doesNotMatch(html, /abanner/);
  // The daily rows are matched by data-act, not by name: activity names now
  // ALSO appear in the "This week" card above (teaching week / pace / streak),
  // so a bare name match would no longer prove the row itself rendered.
  assert.match(html, /data-act="sm"/);
  assert.match(html, /data-act="loe"/);
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
  assert.match(html, /data-act="sm"/);                     // reduced -> still shows
  assert.doesNotMatch(html, /data-act="loe"/);             // pause -> hidden
});

test('renderToday: (c) off-type day — banner shown, no dailies section at all', () => {
  store.events = [];
  loadPlan([{ id: 'p2', start: TODAY, end: TODAY, type: 'off' }]);
  renderToday();
  const html = viewToday.innerHTML;
  assert.match(html, /abanner/);
  assert.match(html, /⏸ Off · day 1 of 1/);
  assert.doesNotMatch(html, /Daily · no time slot/);
  assert.doesNotMatch(html, /data-act="sm"/);
  assert.doesNotMatch(html, /data-act="loe"/);
});

test('renderToday: next-trip chip skips a period whose own start day is shadowed by an off period', () => {
  store.events = [];
  const tripStart = addDays(TODAY, 10), tripEnd = addDays(TODAY, 20);
  // An `off` period blankets the trip's opening days. dayAway resolves those
  // days to the off period, so the trip never renders as itself on day one —
  // advertising "Dhaka in 10 days" would name a banner that never appears.
  loadPlan([
    { id: 'p1', start: addDays(TODAY, 5), end: addDays(TODAY, 12), type: 'off', label: 'Eid break' },
    { id: 'p2', start: tripStart, end: tripEnd, type: 'travel', label: 'Dhaka' },
  ]);
  renderToday();
  const html = viewToday.innerHTML;
  assert.match(html, /⏸ Eid break in 5 days/);              // the period that DOES own its start
  assert.doesNotMatch(html, /Dhaka/);                        // shadowed -> not advertised
});

test('renderToday: next-trip chip still shows an overlapped period that owns its own start day', () => {
  store.events = [];
  // Same two periods, but the trip starts BEFORE the off block, so its first
  // day resolves to itself and it is a real, visible upcoming trip.
  loadPlan([
    { id: 'p2', start: addDays(TODAY, 3), end: addDays(TODAY, 20), type: 'travel', label: 'Dhaka' },
    { id: 'p1', start: addDays(TODAY, 8), end: addDays(TODAY, 12), type: 'off', label: 'Eid break' },
  ]);
  renderToday();
  const html = viewToday.innerHTML;
  assert.match(html, /✈ Dhaka in 3 days/);                   // nearest, and it owns its start
  assert.doesNotMatch(html, /Eid break/);                    // only ONE next-trip chip renders
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

// ── "This week" card ─────────────────────────────────────────
// thisWeekHtml takes the date, so these assert real cycle/streak arithmetic on
// fixed dates instead of whatever day the suite happens to run on.
const loeDone = dates => dates.map(date => ({ date, activityId: 'loe', status: 'done' }));

test('thisWeekHtml: teaching week + cycle pace line; the chip stays neutral early in the cycle', () => {
  loadPlan([]);
  const h = thisWeekHtml('2026-08-18');                   // cycle runs Aug 17–30
  assert.match(h, /<div class="psec">This week<\/div>/);
  assert.match(h, /Teaching week 1/);
  assert.match(h, /<b>Logic of English<\/b> — 0 of 3–4 this cycle/);
  assert.doesNotMatch(h, /pchip ok/);
  assert.doesNotMatch(h, /pchip warn/);                   // 0 of 3 on day 2 says nothing yet
});

test('thisWeekHtml: warn only inside the cycle’s last 3 days, ok as soon as the target is met', () => {
  loadPlan([]);
  assert.match(thisWeekHtml('2026-08-27'), /0 of 3–4 this cycle<\/span><\/div>/);  // day 11: still neutral
  assert.match(thisWeekHtml('2026-08-28'), /pchip warn/);                          // last 3 days
  assert.match(thisWeekHtml('2026-08-30'), /pchip warn/);
  loadPlan([]);
  plan.data.log.push(...loeDone(['2026-08-17', '2026-08-18', '2026-08-19']));
  const ok = thisWeekHtml('2026-08-19');
  assert.match(ok, /3 of 3–4 this cycle/);
  assert.match(ok, /pchip ok">on pace/);
});

test('thisWeekHtml: a daily activity earns a streak line at 3 days (Singapore stays silent while planned)', () => {
  loadPlan([]);
  // The fixture SM is `active`; in production Singapore Math is still `planned`,
  // so this line only appears the day the family activates it.
  plan.data.log.push(...['2026-08-17', '2026-08-18'].map(date =>
    ({ date, activityId: 'sm', status: 'done' })));
  assert.doesNotMatch(thisWeekHtml('2026-08-18'), /streak/);            // 2 days is not a streak
  plan.data.log.push({ date: '2026-08-19', activityId: 'sm', status: 'done' });
  assert.match(thisWeekHtml('2026-08-19'), /<b>Singapore Math<\/b> — 🔥 3-day streak/);
  plan.data.activities.find(a => a.id === 'sm').status = 'planned';
  assert.doesNotMatch(thisWeekHtml('2026-08-19'), /streak/);            // planned -> no line
});

test('thisWeekHtml: majority-away week drops the teaching-week line but keeps the card', () => {
  loadPlan([{ id: 'p1', start: '2026-08-24', end: '2026-08-30', type: 'travel', label: 'Dhaka' }]);
  const h = thisWeekHtml('2026-08-26');
  assert.doesNotMatch(h, /Teaching week/);
  assert.match(h, /Logic of English/);                    // pace still worth stating on the road
});

test('thisWeekHtml: nothing to say -> no card at all', () => {
  loadPlan([]);
  plan.data.activities = [];
  assert.equal(thisWeekHtml('2026-08-10'), '');           // before year.start, no activities
});

test('renderToday: the This week card renders right after the date header', () => {
  store.events = [];
  loadPlan([]);
  renderToday();
  const html = viewToday.innerHTML;
  const head = html.indexOf('class="phead"');
  const card = html.indexOf('>This week<');
  assert.ok(head >= 0 && card > head, 'This week card must follow the date header');
});

// ── Capacity-aware pace chip (review correction) ─────────────
// The cycle that matters here is Aug 17–30 (anchorMonday 2026-08-17): week 1
// is a work week (perOnWeek 1), week 2 a home week (perOffWeek 2.5).
test('thisWeekHtml: a cycle with no capacity left reads "paused" and can never warn', () => {
  loadPlan([{ id: 'p1', start: '2026-08-17', end: '2026-08-30', type: 'off', label: 'Family break' }]);
  for (const day of ['2026-08-18', '2026-08-28', '2026-08-30']) {   // incl. the last 3 days
    const h = thisWeekHtml(day);
    assert.match(h, /<span class="pchip">paused<\/span>/);
    assert.doesNotMatch(h, /pchip warn/);
    assert.doesNotMatch(h, /pchip ok/);
  }
});

test('thisWeekHtml: a trip shrinks the target, so one lesson is "on pace" where three were needed', () => {
  const trip = [{ id: 'p1', start: '2026-08-24', end: '2026-08-30', type: 'travel', label: 'Dhaka' }];
  loadPlan(trip);                                   // LoE pauses on travel -> half the cycle gone
  plan.data.log.push({ date: '2026-08-19', activityId: 'loe', status: 'done' });
  assert.match(thisWeekHtml('2026-08-30'), /pchip ok">on pace/);
  loadPlan([]);                                     // same single lesson, no trip
  plan.data.log.push({ date: '2026-08-19', activityId: 'loe', status: 'done' });
  assert.match(thisWeekHtml('2026-08-30'), /pchip warn/);
});

test('renderToday: on an away day the This week card renders AFTER the banner', () => {
  store.events = [];
  loadPlan([{ id: 'p1', start: TODAY, end: addDays(TODAY, 3), type: 'off', label: 'Break' }]);
  renderToday();
  const html = viewToday.innerHTML;
  const banner = html.indexOf('abanner');
  const card = html.indexOf('>This week<');
  assert.ok(banner >= 0 && card > banner, 'the banner is the headline; the card follows it');
});

// ── "Yesterday" receipt ───────────────────────────────────────
// yesterdayHtml takes the date directly (like thisWeekHtml), so these run on
// fixed dates rather than whatever day the suite happens to run on.
test('yesterdayHtml: mixed statuses — timed event, timed onGrid activity, and a daily/paced entry', () => {
  const Y = '2026-08-17';                                   // Monday, dayIdx 0
  const TACT = {
    id: 'tact', name: 'Ruhamah — ELA/Math', type: 'paced', status: 'active', onGrid: true,
    rhythm: { kind: 'daily' }, slots: [{ day: dayIdx(Y), start: 13, end: 14 }], chain: [],
  };
  store.events = [{ id: 'e1', cat: 'quran', day: dayIdx(Y), start: 10, end: 11, name: 'Quran reading' }];
  plan.data = sanitizePlan({
    year: { label: 'y', start: '2026-08-17', end: '2027-08-31' },
    parentCycle: { anchorMonday: '2026-08-17', dutyStart: '2026-08-11', confirmed: true },
    periods: [], activities: [SM, LOE, TACT],
    log: [
      { date: Y, eventId: 'e1', status: 'done', timed: true },
      { date: Y, activityId: 'tact', status: 'partial', timed: true },
      { date: Y, activityId: 'loe', status: 'missed' },       // daily/paced: no eventId, no timed flag
    ],
    overrides: [],
  });
  assert.equal(yesterdayHtml(Y),
    '<div class="tmwrow">Yesterday: ✓ Quran reading · ◐ Ruhamah — ELA/Math · ✗ Logic of English</div>');
});

test('yesterdayHtml: away day short-circuits to the trip line, ignoring anything logged that day', () => {
  const Y = '2026-08-20';
  loadPlan([{ id: 'p1', start: Y, end: addDays(Y, 2), type: 'travel', label: 'Ski trip' }]);
  plan.data.log.push({ date: Y, activityId: 'loe', status: 'done' });
  assert.equal(yesterdayHtml(Y), '<div class="tmwrow">Yesterday: ✈ Ski trip</div>');
});

test('yesterdayHtml: off-type away day uses the pause icon', () => {
  const Y = '2026-08-20';
  loadPlan([{ id: 'p1', start: Y, end: Y, type: 'off', label: 'Family break' }]);
  assert.equal(yesterdayHtml(Y), '<div class="tmwrow">Yesterday: ⏸ Family break</div>');
});

test('yesterdayHtml: no log entries and not away -> renders nothing (no guilt-tripping empty line)', () => {
  loadPlan([]);
  assert.equal(yesterdayHtml('2026-08-17'), '');
});

test('yesterdayHtml: a fully-deleted event is skipped silently rather than showing a blank name', () => {
  const Y = '2026-08-17';
  store.events = [];                                        // e1 no longer exists anywhere
  loadPlan([]);
  plan.data.log.push({ date: Y, eventId: 'e1', status: 'done', timed: true });
  assert.equal(yesterdayHtml(Y), '');
});

test('yesterdayHtml: an event moved off that weekday still resolves via the raw evLabel fallback', () => {
  const Y = '2026-08-17';                                   // Monday, dayIdx 0
  store.events = [{ id: 'e1', cat: 'quran', day: dayIdx(Y) + 1, start: 10, end: 11, name: 'Quran reading' }];
  loadPlan([]);
  plan.data.log.push({ date: Y, eventId: 'e1', status: 'done', timed: true });
  assert.equal(yesterdayHtml(Y), '<div class="tmwrow">Yesterday: ✓ Quran reading</div>');
});

test('yesterdayHtml: renders in schedule order, not tap/log order — a late-tapped 9am block still comes first', () => {
  const Y = '2026-08-17';                                   // Monday, dayIdx 0
  store.events = [
    { id: 'e-pm', cat: 'quran', day: dayIdx(Y), start: 16, end: 17, name: 'Afternoon block' },
    { id: 'e-am', cat: 'quran', day: dayIdx(Y), start: 9, end: 10, name: 'Morning block' },
  ];
  loadPlan([]);
  // The family taps the 4pm block done first, then goes back and taps the
  // 9am block later — the log records them in that (reversed) order.
  plan.data.log.push({ date: Y, eventId: 'e-pm', status: 'done', timed: true });
  plan.data.log.push({ date: Y, eventId: 'e-am', status: 'done', timed: true });
  assert.equal(yesterdayHtml(Y),
    '<div class="tmwrow">Yesterday: ✓ Morning block · ✓ Afternoon block</div>');
});

// ── Bot interop: an override carries its own identity ────────
// The Telegram bot (aoife-school-bot) writes a one-off as an override with its
// OWN `id` ('x<n>') and a `name`, never an activityId, and logs it back as
// {eventId: 'x1'}. Before planner-v2.4 timedFor built that row with no key at
// all, so statusOf fell into the activityId branch and `undefined ===
// undefined` matched the first other timed entry on the date — the block
// rendered as already-logged, borrowed from a template event.
// Reads the class list of one .tblock by its data-key, so "which block got
// st-done" is asserted per block rather than anywhere in the page.
function tblockCls(html, key) {
  for (const seg of html.split('<div class="tblock ').slice(1)) {
    const q = seg.indexOf('"');
    if (seg.slice(q).startsWith(`" data-key="${key}"`)) return seg.slice(0, q);
  }
  return null;
}

test('renderToday: a bot-written override renders under its own name and is never cross-matched', () => {
  store.events = [{ id: 'e1', cat: 'quran', day: TODAY_DI, start: 10, end: 11, name: 'Quran reading' }];
  loadPlan([]);
  plan.data.overrides.push({ date: TODAY, action: 'add', id: 'x1', name: 'Arya art',
                             start: 15.5, end: 16.5, src: 'tg', note: 'Arya art' });
  plan.data.log.push({ date: TODAY, eventId: 'e1', status: 'missed', timed: true });
  renderToday();
  let html = viewToday.innerHTML;
  assert.match(html, /Arya art/);
  assert.doesNotMatch(html, /makeup/);                    // the bot's name wins over the label
  assert.doesNotMatch(html, /Extra/);
  assert.equal((html.match(/Arya art/g) || []).length, 1);   // note repeats the name -> suppressed
  assert.equal(tblockCls(html, 'ov:x1'), 'ot');           // no st- class: NOT logged
  assert.match(tblockCls(html, 'ev:e1'), /st-missed/);

  // Now the bot logs it the only way it can — by the override's own id.
  plan.data.log.push({ date: TODAY, status: 'done', timed: true, eventId: 'x1' });
  renderToday();
  html = viewToday.innerHTML;
  assert.match(tblockCls(html, 'ov:x1'), /st-done/);
  assert.match(tblockCls(html, 'ev:e1'), /st-missed/);    // the event keeps its own status
});

test('renderToday: the Yesterday receipt renders below the Tomorrow strip', () => {
  const Y = addDays(TODAY, -1);
  const T = addDays(TODAY, 1);
  store.events = [{ id: 'e1', cat: 'quran', day: dayIdx(Y), start: 10, end: 11, name: 'Quran reading' }];
  loadPlan([{ id: 'p9', start: T, end: T, type: 'off', label: 'Tomorrow off' }]);
  plan.data.log.push({ date: Y, eventId: 'e1', status: 'done', timed: true });
  renderToday();
  const html = viewToday.innerHTML;
  assert.match(html, /Tomorrow: ⏸ Tomorrow off/);
  assert.match(html, /Yesterday: ✓ Quran reading/);
  assert.ok(html.indexOf('Tomorrow:') < html.indexOf('Yesterday:'),
    'the Yesterday receipt must follow the Tomorrow strip');
});

// ── Freshness caption ("· synced HH:MM") ────────────────────
// The bot writes this plan from outside the browser, so a tab that has not
// re-read in an hour is showing yesterday's truth. The caption is how that
// becomes visible instead of silently wrong.
test('syncedCaption: renders the local wall-clock time, and nothing at all before the first round', () => {
  assert.equal(syncedCaption(null), '');
  assert.equal(syncedCaption(undefined), '');
  assert.equal(syncedCaption('not a date'), '');
  // Built from LOCAL components on both sides, so the assertion holds in any TZ.
  assert.equal(syncedCaption(new Date(2026, 7, 18, 15, 42).toISOString()), '· synced 3:42pm');
  assert.equal(syncedCaption(new Date(2026, 7, 18, 15, 0)), '· synced 3pm');
  assert.equal(syncedCaption(new Date(2026, 7, 18, 9, 5).toISOString()), '· synced 9:05am');
});

test('renderToday: the caption rides in the date header and reflects the last sync', () => {
  store.events = [];
  loadPlan([]);
  syncInfo.plan = null; syncInfo.schedule = null;
  renderToday();
  assert.match(viewToday.innerHTML, /<span id="psync" class="psync"><\/span>/,
    'an unsynced tab claims nothing');

  // Only ONE blob heard from is still not a synced page: the caption stays mute.
  markSynced('plan', new Date(2026, 7, 18, 14, 7).toISOString());
  renderToday();
  assert.match(viewToday.innerHTML, /<span id="psync" class="psync"><\/span>/,
    'half a sync is not a sync');

  bothSyncedAt(new Date(2026, 7, 18, 14, 7).toISOString());
  renderToday();
  const html = viewToday.innerHTML;
  assert.match(html, /<span id="psync" class="psync">· synced 2:07pm<\/span>/);
  assert.ok(html.indexOf('psync') < html.indexOf('tblock') || !html.includes('tblock'),
    'the caption sits in the header card, above the day');
});

test('paintSynced: updates the caption in place, with no re-render of the view', () => {
  store.events = [];
  loadPlan([]);
  bothSyncedAt(new Date(2026, 7, 18, 14, 7).toISOString());
  renderToday();
  const before = viewToday.innerHTML;

  bothSyncedAt(new Date(2026, 7, 18, 16, 30).toISOString());
  paintSynced();

  assert.equal(psync.textContent, '· synced 4:30pm');
  assert.equal(viewToday.innerHTML, before, 'a 120s poll must not rebuild the page under the family');
});
