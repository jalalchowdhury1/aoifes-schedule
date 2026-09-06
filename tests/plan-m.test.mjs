// js/m.js — the /m PWA page. Regression coverage for the one bit of DOM glue
// that is actually a data-integrity trap: the Subjects sheet's "Oops — remove
// last logged session" row.
//
// BUG (caught in review): the row used to find the LAST log row for an
// activity with no `status` filter at all — `!e.timed && !e.eventId`. A
// no-slot daily can carry a status:'missed' row too (the Telegram bot's ✗
// skip button writes one — see aoife-school-bot/lib/compose.py's
// callback_data(..., "missed", ...) for a no-slot item). If THAT was the
// most recent row, the Oops button called `togglePaced(act.id, missedRow.date)`
// on tap. togglePaced (js/plan/state.js) only ever finds-and-removes a
// status:'done' row for that date; finding none, it fell into its ELSE
// branch and PUSHED A BRAND NEW 'done' ROW, silently advancing the
// curriculum — the exact opposite of "remove a session". Fixed by requiring
// status:'done' in the lookup (`lastDoneEntry`), matching what togglePaced
// can actually undo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// js/m.js -> js/plan/state.js / js/state.js touch localStorage/fetch/document
// at commit() time; stub the globals before import, same pattern as
// tests/plan-today.test.mjs.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.fetch = () => Promise.resolve({ json: async () => ({}) });
for (const k of ['alert', 'confirm', 'prompt'])
  globalThis[k] = () => { throw new Error(`${k}() must never be called by /m`); };
globalThis.document = {
  getElementById: () => null,
  addEventListener: () => {},          // js/m.js wires DOMContentLoaded at import time
  dispatchEvent: () => {},
};

const { plan } = await import('../js/plan/state.js');
const { lastDoneEntry, paceCaption, paceSentence, controlsFor, blockGlyph, pillHtml, pillsHtml, travelCaption, assembleWeekTab } = await import('../js/m.js');
const { planGapDays, planDeltaChip, paceGap, paceGapLessons, expectedSessions } = await import('../js/plan/model.js');

const ACT = { id: 'singapore' };

// ── controlsFor (A1, 2026-09-02): the /m Today row's ✓/◐/✗ + chevron/menu
// predicate. js/m.js has no DOM render-test rig (unlike js/plan/today.js), so
// this pins the pure gate itemRowHtml reads directly instead.
test('controlsFor: a timed item with ask:false gets no controls; every other item keeps them', () => {
  assert.equal(controlsFor({ kind: 'timed', ask: false }), false);
  assert.equal(controlsFor({ kind: 'timed', ask: true }), true);
  assert.equal(controlsFor({ kind: 'timed' }), true);              // no ask field -> askable
  assert.equal(controlsFor({ kind: 'daily', ask: false }), true);  // ask only ever applies to timed items
  assert.equal(controlsFor({ kind: 'daily' }), true);
});

test('lastDoneEntry: skips a trailing missed marker, finds the real last DONE row', () => {
  plan.data = { log: [
    { date: '2026-08-28', activityId: 'singapore', status: 'done', curriculum: 'dm3-c1', session: 8 },
    { date: '2026-08-29', activityId: 'singapore', status: 'missed' },   // the bot's ✗ skip button
  ] };
  const last = lastDoneEntry(ACT);
  assert.ok(last, 'must find the earlier done row, not nothing');
  assert.equal(last.date, '2026-08-28');
  assert.equal(last.status, 'done');
});

test('lastDoneEntry: nothing but missed markers -> undefined (no Oops row to show)', () => {
  plan.data = { log: [
    { date: '2026-08-27', activityId: 'singapore', status: 'missed' },
    { date: '2026-08-29', activityId: 'singapore', status: 'missed' },
  ] };
  assert.equal(lastDoneEntry(ACT), undefined);
});

test('lastDoneEntry: never crosses activities, never picks a timed or eventId row', () => {
  plan.data = { log: [
    { date: '2026-08-29', activityId: 'singapore', status: 'done', timed: true },        // timed slot, not a daily
    { date: '2026-08-29', eventId: 'x1', activityId: 'singapore', status: 'done' },       // bot one-off, owned by eventId
    { date: '2026-08-29', activityId: 'loe', status: 'done' },                            // different activity
    { date: '2026-08-28', activityId: 'singapore', status: 'done' },                      // the real one
  ] };
  const last = lastDoneEntry(ACT);
  assert.equal(last.date, '2026-08-28');
});

test('lastDoneEntry: the found row is exactly what togglePaced(act.id, date) can undo', () => {
  // togglePaced's own removal predicate (js/plan/state.js) — lastDoneEntry
  // must return a row this predicate actually matches, or the Oops tap is a
  // silent no-op-turned-add all over again.
  plan.data = { log: [
    { date: '2026-08-28', activityId: 'singapore', status: 'done', curriculum: 'dm3-c1', session: 8 },
  ] };
  const last = lastDoneEntry(ACT);
  const togglePacedMatch = e => e.activityId === ACT.id && e.date === last.date && e.status === 'done' && !e.eventId;
  assert.ok(plan.data.log.some(togglePacedMatch), 'togglePaced must be able to find and remove this exact row');
});

// ── ahead / behind direction (2026-08-31) ───────────────────
// THE BUG: `daysBetween(a, b)` is `b - a`, so daysBetween(finish, baseline)
// is "days EARLIER than planned" and POSITIVE means AHEAD. Both /m surfaces
// that compare a projection to a frozen baseline rolled their own copy of
// that subtraction and both read the sign backwards, so a subject 7 days
// BEHIND its own plan told the family "▲ 7 lessons ahead" — on the live site,
// on the number a parent uses to decide whether to push harder. Both now go
// through the named `planGapDays`, and these tests pin the direction from the
// dates themselves so a future edit cannot silently flip it.
const PLAN_DATE = '2026-12-27';
const LATER = '2027-01-03';        // projection lands AFTER the plan -> behind
const EARLIER = '2026-12-20';      // projection lands BEFORE the plan -> ahead

test('planGapDays: finishing EARLIER than the plan is positive (ahead)', () => {
  assert.equal(planGapDays(EARLIER, PLAN_DATE), 7);
  assert.equal(planGapDays(LATER, PLAN_DATE), -7);
  assert.equal(planGapDays(PLAN_DATE, PLAN_DATE), 0);
  assert.equal(planGapDays(null, PLAN_DATE), null);
  assert.equal(planGapDays(LATER, null), null);
});

test('planGapDays agrees with planDeltaChip, the convention it was cloned from', () => {
  assert.equal(planDeltaChip('2026-11-01', PLAN_DATE).state, 'ahead');
  assert.ok(planGapDays('2026-11-01', PLAN_DATE) > 0);
  assert.equal(planDeltaChip('2027-03-01', PLAN_DATE).state, 'behind');
  assert.ok(planGapDays('2027-03-01', PLAN_DATE) < 0);
});

// ── ahead/behind is PACE, not a difference of two projected dates ──
// THE REAL BUG (2026-08-31, user caught it): both /m surfaces derived
// "N lessons ahead/behind" by differencing the live projected finish against
// the frozen baseline date. projectFinish/chainTimeline walk in WHOLE WEEKS
// anchored on mondayOf(fromDate) and return the SUNDAY of the finishing week,
// so the number carried up to 7 days of pure quantisation.
//
// Live numbers that exposed it: baseline frozen Fri 2026-08-28 (anchor Monday
// Aug 24, 251 sessions, 17.93 weeks charged as 18) -> Dec 27. Three days later
// the walk ran on Mon 2026-08-31 (anchor Monday Aug 31, 239 sessions, 17.07
// weeks ALSO charged as 18) -> Jan 3. The date moved a WEEK LATER while she
// logged 12 sessions in 4 days against a planned 8. The phone said "7 lessons
// behind" for a child 2 lessons AHEAD.
const SM_ACT = {
  id: 'singapore', type: 'paced', status: 'active',
  rhythm: { kind: 'daily', sessionsPerDay: 2 }, travel: { mode: 'reduced', factor: 0.5 },
  baseline: { setOn: '2026-08-28', rows: { 'dm3-c1': '2026-12-27' } },
  chain: [{ id: 'dm3-c1', pattern: 'tb-wb', lessons: 11, tests: 0, done: 12 }],
};
const sessionRow = (date) => ({ date, activityId: 'singapore', status: 'done',
  curriculum: 'dm3-c1', session: 0 });
// The real shape of her first four days: 2, 4, 4, 2.
const SM_PLAN = { periods: [], parentCycle: { anchorMonday: '2026-08-17', dutyStart: '2026-08-11' },
  activities: [SM_ACT],
  log: [...Array(2).fill('2026-08-28'), ...Array(4).fill('2026-08-29'),
        ...Array(4).fill('2026-08-30'), ...Array(2).fill('2026-08-31')].map(sessionRow) };

test('expectedSessions: a 2-a-day plan expects 8 across four inclusive days', () => {
  assert.equal(expectedSessions(SM_ACT, '2026-08-28', '2026-08-31', SM_PLAN), 8);
  assert.equal(expectedSessions(SM_ACT, '2026-08-28', '2026-08-28', SM_PLAN), 2);
  assert.equal(expectedSessions(SM_ACT, '2026-08-31', '2026-08-28', SM_PLAN), 0);  // reversed
  assert.equal(expectedSessions(SM_ACT, 'nonsense', '2026-08-31', SM_PLAN), 0);
});

test('expectedSessions: a trip at half speed lowers what the plan expects', () => {
  const away = { ...SM_PLAN, periods: [{ id: 'p1', start: '2026-08-28', end: '2026-08-31', type: 'travel' }] };
  assert.equal(expectedSessions(SM_ACT, '2026-08-28', '2026-08-31', away), 4);   // 0.5 factor
  const off = { ...SM_PLAN, periods: [{ id: 'p1', start: '2026-08-28', end: '2026-08-31', type: 'off' }] };
  assert.equal(expectedSessions(SM_ACT, '2026-08-28', '2026-08-31', off), 0);
});

// ── skip-aware capacity (A2, 2026-09-02): expectedSessions half of the rule ──
test('expectedSessions: a daily rhythm prices a skipped date at 0 (loses that day\'s full sessionsPerDay)', () => {
  const withSkip = { ...SM_PLAN, overrides: [{ date: '2026-08-29', action: 'skip', activityId: 'singapore' }] };
  assert.equal(expectedSessions(SM_ACT, '2026-08-28', '2026-08-31', withSkip), 6);   // 8 - 2 (mult), not 8 - 1
  // A skip for a DIFFERENT activity, or dated outside the range, changes nothing.
  const otherAct = { ...SM_PLAN, overrides: [{ date: '2026-08-29', action: 'skip', activityId: 'loe' }] };
  assert.equal(expectedSessions(SM_ACT, '2026-08-28', '2026-08-31', otherAct), 8);
  const outside = { ...SM_PLAN, overrides: [{ date: '2026-09-05', action: 'skip', activityId: 'singapore' }] };
  assert.equal(expectedSessions(SM_ACT, '2026-08-28', '2026-08-31', outside), 8);
});

test('expectedSessions: a weekly/cycle rhythm loses exactly one session over two weeks with one skip', () => {
  const WEEKLY_ACT = { id: 'geography', rhythm: { kind: 'weekly', perWeek: 1 }, travel: { mode: 'pause' } };
  const plan = { periods: [], parentCycle: { anchorMonday: '2026-08-17', dutyStart: '2026-08-11' },
    activities: [WEEKLY_ACT] };
  const base = expectedSessions(WEEKLY_ACT, '2026-08-17', '2026-08-30', plan);       // 2 full weeks
  assert.ok(Math.abs(base - 2) < 1e-9, String(base));
  const withSkip = { ...plan, overrides: [{ date: '2026-08-19', action: 'skip', activityId: 'geography' }] };
  const skipped = expectedSessions(WEEKLY_ACT, '2026-08-17', '2026-08-30', withSkip);
  assert.ok(Math.abs(skipped - 1) < 1e-9, String(skipped));
});

test('paceGap: the live case reads 2 lessons AHEAD, not 7 behind', () => {
  const g = paceGapLessons(SM_ACT, SM_PLAN, '2026-08-31');
  assert.equal(g.done, 12);
  assert.equal(g.expected, 8);
  assert.equal(g.sessions, 4);
  assert.equal(g.lessons, 2);            // a tb-wb lesson is two sessions
  assert.equal(g.since, '2026-08-28');
});

test('paceGap: rows logged BEFORE the freeze are not credited to it', () => {
  const withOlder = { ...SM_PLAN, log: [sessionRow('2026-08-20'), sessionRow('2026-08-27'), ...SM_PLAN.log] };
  assert.equal(paceGap(SM_ACT, withOlder, '2026-08-31').done, 12);
});

test('paceGap: markers and timed rows are not sessions', () => {
  const noisy = { ...SM_PLAN, log: [...SM_PLAN.log,
    { date: '2026-08-30', activityId: 'singapore', status: 'missed' },
    { date: '2026-08-30', activityId: 'singapore', status: 'done', timed: true },
    { date: '2026-08-30', activityId: 'singapore', status: 'done' }] };   // no curriculum
  assert.equal(paceGap(SM_ACT, noisy, '2026-08-31').done, 12);
});

test('paceGap: no baseline, or one frozen in the future, measures nothing', () => {
  assert.equal(paceGap({ ...SM_ACT, baseline: undefined }, SM_PLAN, '2026-08-31'), null);
  assert.equal(paceGap(SM_ACT, SM_PLAN, '2026-08-27'), null);            // today before the freeze
});

test('paceSentence: says AHEAD and shows its working on the live numbers', () => {
  const g = paceGapLessons(SM_ACT, SM_PLAN, '2026-08-31');
  const txt = paceSentence(g, '2027-01-03', '2026-12-27');
  assert.match(txt, /2 lessons ahead/);
  assert.match(txt, /12<\/b> sessions logged since Aug 28, 2026/);
  assert.match(txt, /expected <b>8<\/b>/);
  assert.equal(/behind/.test(txt), false, 'the live wording that was wrong');
});

test('paceSentence: explains the dates ONLY when they point the other way', () => {
  const g = paceGapLessons(SM_ACT, SM_PLAN, '2026-08-31');
  // Ahead, yet the projected finish is later than the plan: the 7-day step.
  // 2026-09-05: dates are exact days now, so the explanation names the real
  // causes (a trip in between / a plan frozen before a trip) instead of 7-day steps.
  assert.match(paceSentence(g, '2027-01-03', '2026-12-27'), /exact days/);
  assert.doesNotMatch(paceSentence(g, '2027-01-03', '2026-12-27'), /jump 7 days/);
  // Ahead and the dates agree: no explanation needed.
  assert.equal(/exact days/.test(paceSentence(g, '2026-12-20', '2026-12-27')), false);
});

test('paceCaption: the Now tile says the same thing, shorter', () => {
  assert.equal(paceCaption(paceGapLessons(SM_ACT, SM_PLAN, '2026-08-31')), '2 lessons ahead');
  assert.equal(paceCaption(null), 'no plan frozen yet');
  const onPlan = { ...SM_PLAN, log: SM_PLAN.log.slice(0, 8) };
  assert.equal(paceCaption(paceGapLessons(SM_ACT, onPlan, '2026-08-31')), 'on plan');
});

test('paceSentence: with no baseline it says so instead of claiming zero', () => {
  assert.match(paceSentence(null), /No plan frozen for this subject yet/);
});

// ── Week grid block glyph: emoji when unanswered, status mark once answered ──
test('blockGlyph: an unanswered block shows its emoji quietly; an answered one shows its mark; a sliver shows nothing', () => {
  const geo = { emoji: '🌍', status: null };
  assert.equal(blockGlyph(geo, 20, 'plan'), '<span class="wkemo">🌍</span>');
  assert.equal(blockGlyph(geo, 20, 'open'), '<span class="wkemo">🌍</span>');
  assert.equal(blockGlyph({ ...geo, status: 'done' }, 20, 'done'), '✓');
  assert.equal(blockGlyph({ ...geo, status: 'missed' }, 20, 'missed'), '✗');
  assert.equal(blockGlyph(geo, 10, 'plan'), '');
  assert.equal(blockGlyph({ status: null }, 20, 'plan'), '');
});

// ── Subjects card pills (style C) ──
test('pillHtml: three shapes by state; the current one carries dots, reviews and the count', () => {
  assert.equal(pillHtml({ kind: 'done', short: 'Ch 1' }), '<span class="pill done">Ch 1 ✓</span>');
  assert.equal(pillHtml({ kind: 'todo', short: 'Ch 3', label: '3A Ch 3', total: 7 }), '<span class="pill todo" title="3A Ch 3">Ch 3<small>7</small></span>');
  const cur = pillHtml({ kind: 'cur', short: 'Ch 2', label: '3A Ch 2 · Add', dots: ['full', 'half', 'empty'], revs: [false], done: 1.5, total: 3 });
  assert.match(cur, /^<span class="pill cur" title="3A Ch 2 · Add"><em>Ch 2<\/em>/);
  assert.match(cur, /<i class="pd full"><\/i><i class="pd half"><\/i><i class="pd empty"><\/i><i class="prv">◆<\/i><b>1.5\/3<\/b><\/span>$/);
  assert.equal(pillsHtml({ pills: [] }), '');
  assert.match(pillsHtml({ pills: [{ kind: 'done', short: 'Ch 1' }] }), /^<div class="pills">.*<\/div>$/);
});

// ── Subjects sheet subtitle: the travel clause describes the REAL pace ──────
// 2026-09-05: it used to hard-code " · half speed on trips" for any `reduced`
// mode. The DC trip now prices Singapore at 0.67 via periods[].factors while
// the winter trip stays 0.5, so the clause names such trips explicitly.
const SM_T = { id: 'singapore', travel: { mode: 'reduced', factor: 0.5 } };
const DC_T = { id: 'p2', start: '2026-09-30', end: '2026-10-05', type: 'travel',
  label: "DC trip — staying at Raisa Khalamoni's", factors: { singapore: 0.67 } };
const WINTER_T = { id: 'p1', start: '2027-01-04', end: '2027-02-07', type: 'travel',
  label: 'Winter trip: IST/Dhaka/Bangkok/Singapore (est. — book ~Sept)' };

test('travelCaption: reduced at ½ with no per-trip factors reads exactly as before', () => {
  assert.equal(travelCaption(SM_T, [WINTER_T]), ' · half speed on trips');
  assert.equal(travelCaption(SM_T, []), ' · half speed on trips');
  assert.equal(travelCaption(SM_T, undefined), ' · half speed on trips');
});

test('travelCaption: a per-trip factor for this activity is appended, named by the label\'s first clause', () => {
  assert.equal(travelCaption(SM_T, [DC_T, WINTER_T]), ' · half speed on trips · DC trip: 67%');
});

test('travelCaption: a per-trip factor for ANOTHER activity is not mentioned', () => {
  assert.equal(travelCaption({ id: 'geography', travel: { mode: 'pause' } }, [DC_T]), ' · pauses on trips');
});

test('travelCaption: a per-trip factor overrides even a pause mode, and says so', () => {
  const dc = { ...DC_T, factors: { geography: 1 } };
  assert.equal(travelCaption({ id: 'geography', travel: { mode: 'pause' } }, [dc]), ' · pauses on trips · DC trip: 100%');
});

test('travelCaption: a reduced factor other than ½ is spelled as a percentage; missing factor = ½', () => {
  assert.equal(travelCaption({ id: 'x', travel: { mode: 'reduced', factor: 0.25 } }, []), ' · 25% speed on trips');
  assert.equal(travelCaption({ id: 'x', travel: { mode: 'reduced' } }, []), ' · half speed on trips');
});

test('travelCaption: continue and pause modes are unchanged', () => {
  assert.equal(travelCaption({ id: 'x', travel: { mode: 'continue' } }, []), ' · keeps going on trips');
  assert.equal(travelCaption({ id: 'x' }, []), ' · pauses on trips');
});

test('travelCaption: an unlabelled period falls back to its id; off periods never appear', () => {
  const bare = { id: 'p9', start: '2026-11-01', end: '2026-11-02', type: 'travel', factors: { singapore: 0.8 } };
  const off = { id: 'o1', start: '2026-11-03', end: '2026-11-03', type: 'off', factors: { singapore: 1 } };
  assert.equal(travelCaption(SM_T, [bare, off]), ' · half speed on trips · p9: 80%');
});

// ── Week tab section order (user, 2026-09-06: "put the today on top and the
// changes this week below it, the other stuff stays where it is") ──────────
// Was: nav · summary · grid · changes · selected day. Now the selected-day
// card comes first under the nav, then Changes, then the glance (summary +
// grid) in their old relative order. assembleWeekTab is the pure assembly
// renderWeek feeds; pinning it here keeps the order from silently reverting.
test('assembleWeekTab: nav, then the selected day, then changes, then summary + grid', () => {
  const parts = { nav: '<NAV>', thisWeek: '<THISWEEK>', summary: '<SUMMARY>', grid: '<GRID>',
    changes: '<CHANGES>', dayHead: '<DAYHEAD>', dayBody: '<DAYBODY>' };
  const html = assembleWeekTab(parts);
  const at = s => html.indexOf(s);
  for (const s of Object.values(parts)) assert.ok(at(s) >= 0, `${s} missing`);
  assert.ok(at('<NAV>') < at('<THISWEEK>'), 'nav before This-week button');
  assert.ok(at('<THISWEEK>') < at('<DAYHEAD>'), 'This-week button before the day card');
  assert.ok(at('<DAYHEAD>') < at('<DAYBODY>'), 'day heading before its body');
  assert.ok(at('<DAYBODY>') < at('<CHANGES>'), 'day card before Changes this week');
  assert.ok(at('<CHANGES>') < at('<SUMMARY>'), 'Changes before the week summary');
  assert.ok(at('<SUMMARY>') < at('<GRID>'), 'summary before the grid (unchanged relative order)');
  assert.equal(assembleWeekTab({ ...parts, thisWeek: '' }).includes('<THISWEEK>'), false);
});
