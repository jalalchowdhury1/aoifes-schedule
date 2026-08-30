// The ONE engine behind the /m PWA page and the Scriptable widget. Fixture is
// a trimmed snapshot of REAL production shapes (curl'd from
// https://aoifes-schedule.vercel.app/api/get and /api/plan-get on
// 2026-08-30) — tests/fixtures/plan-mday-{schedule,plan}.json. Numbers below
// (5/123 · 4% · finish Dec 27 · streak 3) are the actual live state on that
// date, not invented — cross-checked against js/plan/model.js's own
// lessonTotals/projectFinish/chainTimeline/dailyStreak before being pinned
// here as assertions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sanitizePlan } from '../js/plan/model.js';
import {
  dayItems, dayHeader, nowBlock, subjectCards, widgetModel, fmtHM,
  dailyStatus, dailyVisible, buildTimed, statusOfTimed, emojiFor, colorFor,
  EMOJI_MAP, EMOJI_FALLBACK, dayState, fieldClassFor, receipt,
} from '../js/plan/mday.js';

const events = JSON.parse(readFileSync(new URL('./fixtures/plan-mday-schedule.json', import.meta.url), 'utf8')).events;
const rawPlan = JSON.parse(readFileSync(new URL('./fixtures/plan-mday-plan.json', import.meta.url), 'utf8'));
const plan = sanitizePlan(rawPlan);

const MON = '2026-08-31';   // Monday — the spec's pinned test date (tomorrow relative to the fixture's "now", 2026-08-30)
const TODAY = '2026-08-30'; // the fixture's real "as of" date (streak/finish asserted against this)

// ── dayItems: 4 items, in order, for Mon Aug 31 ──────────────
test('dayItems: Mon Aug 31 — 4 items, timed first (Quran, Ruhama) then no-slot dailies (Singapore, LoE)', () => {
  const items = dayItems(MON, events, plan);
  assert.equal(items.length, 4);
  assert.deepEqual(items.map(it => it.kind), ['timed', 'timed', 'daily', 'daily']);

  const [quran, ruhama, sm, loe] = items;
  assert.equal(quran.name, 'Quran');
  assert.equal(quran.start, 10);
  assert.equal(quran.end, 11);
  assert.equal(quran.emoji, '📖');

  assert.match(ruhama.name, /Ruhama/);
  assert.equal(ruhama.start, 11);
  assert.equal(ruhama.end, 13);
  assert.equal(ruhama.emoji, '✏️');

  assert.equal(sm.activityId, 'singapore');
  assert.equal(sm.note, '3A Ch 1 · Lesson 6 · textbook');
  assert.equal(sm.emoji, '➗');
  assert.equal(sm.status, undefined);         // nothing logged yet for this future date

  assert.equal(loe.activityId, 'loe');
  assert.equal(loe.note, 'Lesson 105');
  assert.equal(loe.emoji, '📚');
  assert.equal(loe.status, undefined);
});

test('dayItems: an optional nameForEvent resolver overrides the default (catLabels renames, js/m.js + the widget)', () => {
  // Regression: dayItems used to call buildTimed with no resolver at all, so
  // any caller other than today.js's own timedFor (which passes evLabel)
  // silently lost catLabels renames — /m and the widget would show the plain
  // CATS default label even when the family renamed the category.
  const items = dayItems(MON, events, plan, ev => `RENAMED ${ev.cat}`);
  const quran = items.find(it => it.eventId != null && it.start === 10);
  assert.equal(quran.name, 'RENAMED quran');
});

test('dayItems: away day — timed blocks vanish, dailies still filtered by dailyVisible', () => {
  const away = sanitizePlan({ ...rawPlan,
    periods: [{ id: 'pX', start: MON, end: MON, type: 'travel', label: 'Trip' }] });
  const items = dayItems(MON, events, away);
  assert.ok(items.every(it => it.kind !== 'timed'));
  // singapore travels 'reduced' -> still visible; loe pauses -> hidden
  assert.ok(items.some(it => it.activityId === 'singapore'));
  assert.ok(!items.some(it => it.activityId === 'loe'));
});

// ── dailyStatus: mirrors the bot's item_status, plus the 'half' state ──
test('dailyStatus: a missed marker settles the day outright (real fixture date 2026-08-20)', () => {
  const sm = plan.activities.find(a => a.id === 'singapore');
  assert.equal(dailyStatus(sm, plan.log, '2026-08-20'), 'missed');
});

test('dailyStatus: both halves of the latest lesson logged today -> done (real fixture date 2026-08-30)', () => {
  const sm = plan.activities.find(a => a.id === 'singapore');
  // 2026-08-30 log: sessions 6,7,8,9 done (two full lesson pairs) — latest lesson (4) has both halves.
  assert.equal(dailyStatus(sm, plan.log, '2026-08-30'), 'done');
});

test('dailyStatus: only the textbook half of the latest lesson logged today -> half', () => {
  const sm = plan.activities.find(a => a.id === 'singapore');
  // cur.done is 10 sessions in on the fixture -> next session index 10 (lesson 6, textbook).
  const log = [...plan.log, { date: MON, activityId: 'singapore', status: 'done', curriculum: 'dm3-c1', session: 10 }];
  assert.equal(dailyStatus(sm, log, MON), 'half');
  const log2 = [...log, { date: MON, activityId: 'singapore', status: 'done', curriculum: 'dm3-c1', session: 11 }];
  assert.equal(dailyStatus(sm, log2, MON), 'done');       // workbook half lands -> done
});

test('dailyStatus: nothing logged today -> undefined', () => {
  const sm = plan.activities.find(a => a.id === 'singapore');
  assert.equal(dailyStatus(sm, plan.log, MON), undefined);
});

test('dailyStatus: a simple-pattern (non tb-wb) chain reads done from a bare done row', () => {
  const loe = plan.activities.find(a => a.id === 'loe');
  const log = [{ date: MON, activityId: 'loe', status: 'done', curriculum: 'loe-c', session: 4 }];
  assert.equal(dailyStatus(loe, log, MON), 'done');
});

// ── dayHeader ─────────────────────────────────────────────────
test('dayHeader: Mon Aug 31 — date label, Mama work day (LoE is an active cycle-rhythm subject), no away banner', () => {
  const h = dayHeader(MON, plan);
  assert.equal(h.dateLabel, 'Mon Aug 31');
  assert.equal(h.mama, 'work');
  assert.equal(h.away, null);
});

test('dayHeader: an away period produces the away banner with the icon stripped from the label', () => {
  const away = sanitizePlan({ ...rawPlan,
    periods: [{ id: 'pX', start: MON, end: MON, type: 'travel', label: 'Dhaka ✈' }] });
  const h = dayHeader(MON, away);
  assert.deepEqual(h.away, { type: 'travel', label: 'Dhaka' });
});

test('dayHeader: mama is null when no active cycle-rhythm subject exists', () => {
  const noCycle = sanitizePlan({ ...rawPlan,
    activities: rawPlan.activities.map(a => (a.id === 'loe' ? { ...a, status: 'parked' } : a)) });
  assert.equal(dayHeader(MON, noCycle).mama, null);
});

// ── nowBlock ──────────────────────────────────────────────────
test('nowBlock: mid-block -> state "now" with minutesLeft', () => {
  const items = dayItems(MON, events, plan);
  const nb = nowBlock(MON, items, 11.5);          // 11:30, inside Ruhama 11-13
  assert.equal(nb.state, 'now');
  assert.match(nb.item.name, /Ruhama/);
  assert.equal(nb.minutesLeft, 90);
});

test('nowBlock: before the first block -> state "next" with minutesUntil', () => {
  const items = dayItems(MON, events, plan);
  const nb = nowBlock(MON, items, 9);             // 9:00, before Quran at 10
  assert.equal(nb.state, 'next');
  assert.equal(nb.item.name, 'Quran');
  assert.equal(nb.minutesUntil, 60);
});

test('nowBlock: after the last timed block -> state "after" with a count of unlogged items', () => {
  // Log the two timed blocks so only the two dailies are left unlogged.
  const logged = sanitizePlan({ ...rawPlan, log: [...rawPlan.log,
    { date: MON, eventId: 'e1001', status: 'done', timed: true },
    { date: MON, eventId: 'e1007', status: 'done', timed: true }] });
  const items = dayItems(MON, events, logged);
  const nb = nowBlock(MON, items, 14);            // 2pm, after Ruhama ends at 13
  assert.equal(nb.state, 'after');
  assert.equal(nb.item, null);
  assert.equal(nb.left, 2);                       // Singapore + LoE still unlogged

  const nothingLogged = nowBlock(MON, dayItems(MON, events, plan), 14);
  assert.equal(nothingLogged.left, 4);            // real fixture: nothing logged yet for a future date
});

// ── subjectCards ──────────────────────────────────────────────
test('subjectCards: order is SUBJECT_ORDER (paced only) — Singapore, LoE, Geography, History', () => {
  const cards = subjectCards(plan, TODAY);
  assert.deepEqual(cards.map(c => c.id), ['singapore', 'loe', 'geography', 'history']);
});

test('subjectCards: Singapore as of 2026-08-30 — 5/123 lessons, 4%, finish Dec 27, on-plan delta, 3-day streak', () => {
  const sm = subjectCards(plan, TODAY).find(c => c.id === 'singapore');
  assert.equal(sm.lessonsDone, 5);
  assert.equal(sm.lessonsTotal, 123);
  assert.equal(sm.pct, 4);
  assert.equal(sm.finish, '2026-12-27');
  assert.deepEqual(sm.delta, { state: 'on', weeks: 0 });
  assert.equal(sm.streak, 3);
  assert.equal(sm.isTbWb, true);
  assert.equal(sm.chapterLabel, '3A Ch 1 · Numbers to 10,000');
  assert.equal(sm.chapterDone, 5);
  assert.equal(sm.chapterSessions, 11);
  assert.equal(sm.nextLabel, 'Lesson 6 · textbook');
  assert.equal(sm.color, '#e8834a');
  assert.equal(sm.status, 'active');
});

test('subjectCards: a planned subject (Geography) carries its status and zero counts, but no finish/delta', () => {
  const geo = subjectCards(plan, TODAY).find(c => c.id === 'geography');
  assert.equal(geo.status, 'planned');
  assert.equal(geo.lessonsDone, 0);
  assert.equal(geo.lessonsTotal, 30);
  assert.equal(geo.finish, null);
  assert.equal(geo.delta, null);
  assert.equal(geo.isTbWb, false);
  assert.equal(geo.color, '#4cc9b0');
});

test('subjectCards: an unlisted id sorts after every known one and gets the neutral color', () => {
  const withExtra = sanitizePlan({ ...rawPlan, activities: [...rawPlan.activities,
    { id: 'zzz-future', name: 'Future Subject', type: 'paced', status: 'planned', onGrid: false, chain: [] }] });
  const cards = subjectCards(withExtra, TODAY);
  assert.equal(cards[cards.length - 1].id, 'zzz-future');
  assert.equal(cards[cards.length - 1].color, '#9aa0b4');
});

// ── widgetModel ───────────────────────────────────────────────
test('widgetModel: Mon Aug 31 — the exact strings the widget renders', () => {
  const w = widgetModel(MON, events, plan, 8);
  assert.equal(w.dayLabel, 'Today · Mon');
  assert.equal(w.first, '10:00 Quran');
  assert.equal(w.rest, '11:00 Ruhama · then Singapore + LoE');
  assert.equal(w.done, 0);
  assert.equal(w.total, 4);
  assert.equal(w.mama, 'Mama: work day');
});

test('widgetModel: an optional nameForEvent resolver renames the timed strings ("first"/"rest") the widget draws', () => {
  const w = widgetModel(MON, events, plan, 8, () => 'Renamed');
  assert.equal(w.first, '10:00 Renamed');
  assert.equal(w.rest, '11:00 Renamed · then Singapore + LoE');
});

test('widgetModel: done counts items whose status is "done"', () => {
  const withLog = sanitizePlan({ ...rawPlan,
    log: [...rawPlan.log, { date: MON, eventId: events.find(e => e.name === 'Quran' && e.day === 0).id, status: 'done', timed: true }] });
  const w = widgetModel(MON, events, withLog, 8);
  assert.equal(w.done, 1);
  assert.equal(w.total, 4);
});

test('widgetModel: a day with only ONE timed block never fabricates a time for the no-slot daily that lands in "rest"', () => {
  // 2026-08-30 (Sunday) in the real fixture has exactly one timed block
  // (Ruhama) — items[1] is a no-slot daily (Singapore), which has no
  // `start`. Regression: this used to render "12:00 Singapore" (fmtHM(0)
  // filling in for the missing start), inventing a time slot that does not
  // exist. Caught verifying the live deploy against this exact real date.
  const w = widgetModel('2026-08-30', events, plan, 8);
  assert.doesNotMatch(w.rest, /^\d/, 'no leading digit — a daily gets no fabricated h:mm prefix');
  assert.equal(w.rest, 'Singapore · then LoE');
});

test('widgetModel: a day with NO timed blocks at all never fabricates a time for "first" either', () => {
  const allAway = sanitizePlan({ ...rawPlan,
    periods: [{ id: 'pAway', start: '2026-08-30', end: '2026-08-30', type: 'travel', label: 'Trip' }] });
  const w = widgetModel('2026-08-30', events, allAway, 8);
  assert.doesNotMatch(w.first, /^\d/);
  assert.equal(w.first, 'Singapore');   // only the reduced-travel daily survives
});

// ── fmtHM ─────────────────────────────────────────────────────
test('fmtHM: h:mm, no am/pm suffix', () => {
  assert.equal(fmtHM(10), '10:00');
  assert.equal(fmtHM(11), '11:00');
  assert.equal(fmtHM(13), '1:00');            // 1pm -> 1:00, no suffix (mirrors the bot's fmt_hm)
  assert.equal(fmtHM(9.5), '9:30');
  assert.equal(fmtHM(0), '12:00');
});

// ── dailyVisible (moved here from today.js; today.js re-exports it) ──
test('dailyVisible: normal day always visible; travel-day respects travel.mode; off-day hides all', () => {
  const reduced = { travel: { mode: 'reduced', factor: 0.5 } };
  const pause = { travel: { mode: 'pause' } };
  const away = t => ({ away: true, type: t });
  assert.equal(dailyVisible(reduced, { away: false }), true);
  assert.equal(dailyVisible(reduced, away('travel')), true);
  assert.equal(dailyVisible(pause, away('travel')), false);
  assert.equal(dailyVisible(reduced, away('off')), false);
});

// ── emojiFor / colorFor ───────────────────────────────────────
test('emojiFor: known keys map to the bot\'s EMOJI_MAP, unknown keys fall back', () => {
  assert.equal(emojiFor('quran'), '📖');
  assert.equal(emojiFor('singapore'), '➗');
  assert.equal(emojiFor('loe'), '📚');
  assert.equal(emojiFor('nonsense'), EMOJI_FALLBACK);
  assert.equal(emojiFor(undefined), EMOJI_FALLBACK);
  assert.equal(Object.keys(EMOJI_MAP).length, 10);
});

test('colorFor: the three named subjects get their dot color, everything else neutral', () => {
  assert.equal(colorFor('singapore'), '#e8834a');
  assert.equal(colorFor('loe'), '#5ea3f2');
  assert.equal(colorFor('geography'), '#4cc9b0');
  assert.equal(colorFor('history'), '#9aa0b4');
});

// ── dayState / fieldClassFor (polish round 2, item A/G): the ONE function
// behind both the Today hero and the field's state color ──────
test('dayState: mid-block -> phase "now", agrees with nowBlock', () => {
  const items = dayItems(MON, events, plan);
  const ds = dayState(items, 11.5);
  assert.equal(ds.phase, 'now');
  assert.match(ds.item.name, /Ruhama/);
  assert.equal(ds.minutesLeft, 90);
  assert.equal(fieldClassFor(ds), 'day');
});

test('dayState: before the first block -> phase "next"', () => {
  const items = dayItems(MON, events, plan);
  const ds = dayState(items, 9);
  assert.equal(ds.phase, 'next');
  assert.equal(ds.item.name, 'Quran');
  assert.equal(ds.minutesUntil, 60);
  assert.equal(fieldClassFor(ds), 'day');
});

test('dayState: after the last block, everything answered -> phase "done" (green field), never an ISO-date caption bug', () => {
  const logged = sanitizePlan({ ...rawPlan, log: [...rawPlan.log,
    { date: MON, eventId: 'e1001', status: 'done', timed: true },
    { date: MON, eventId: 'e1007', status: 'done', timed: true },
    { date: MON, activityId: 'singapore', status: 'missed' },   // a MISS still counts as "answered"
    { date: MON, activityId: 'loe', status: 'done', curriculum: 'loe-c', session: 5 }] });
  const items = dayItems(MON, events, logged);
  const ds = dayState(items, 14);
  assert.equal(ds.phase, 'done');
  assert.equal(ds.total, 4);
  assert.equal(ds.answered, 4);
  assert.equal(fieldClassFor(ds), 'done');
});

test('dayState: after the last block, something unanswered -> phase "left" with names, violet before 18:00', () => {
  const logged = sanitizePlan({ ...rawPlan, log: [...rawPlan.log,
    { date: MON, eventId: 'e1001', status: 'done', timed: true },
    { date: MON, eventId: 'e1007', status: 'done', timed: true }] });
  const items = dayItems(MON, events, logged);
  const ds = dayState(items, 14);          // 2pm — before the late threshold
  assert.equal(ds.phase, 'left');
  assert.equal(ds.left, 2);
  assert.deepEqual(ds.names.sort(), ['Logic of English', 'Singapore Math'].sort());
  assert.equal(ds.late, false);
  assert.equal(fieldClassFor(ds), 'day');
});

test('dayState: "left" past 18:00 -> late (amber field)', () => {
  const items = dayItems(MON, events, plan);
  const ds = dayState(items, 19);
  assert.equal(ds.phase, 'left');
  assert.equal(ds.late, true);
  assert.equal(fieldClassFor(ds), 'late');
});

test('dayState: no loggable items at all -> phase "empty", never divides by zero into a false "done"', () => {
  const ds = dayState([], 14);
  assert.equal(ds.phase, 'empty');
  assert.equal(ds.left, 0);
  assert.equal(ds.total, 0);
  assert.equal(fieldClassFor(ds), 'day');
});

test('nowBlock stays byte-compatible with dayState after the refactor (back-compat wrapper)', () => {
  const items = dayItems(MON, events, plan);
  assert.deepEqual(nowBlock(MON, items, 11.5), { state: 'now', item: dayState(items, 11.5).item, minutesLeft: 90 });
});

// ── receipt (polish round 2, item B): collapsed per-activity recap ──
test('receipt: 2026-08-29 (real fixture) — Ruhama missed, Singapore L2 + L3, LoE Lesson 104', () => {
  const rows = receipt('2026-08-29', events, plan);
  const byName = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.equal(byName['Ruhama'].mark, '✗');
  assert.equal(byName['Ruhama'].detail, '');
  assert.equal(byName['Singapore'].mark, '✓');
  assert.equal(byName['Singapore'].detail, 'L2 + L3');
  assert.equal(byName['LoE'].mark, '✓');
  assert.equal(byName['LoE'].detail, 'Lesson 104');
});

test('receipt: 2026-08-30 (real fixture) — Ruhama missed, LoE missed (marker, no detail), Singapore L4 + L5', () => {
  const rows = receipt('2026-08-30', events, plan);
  const byName = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.equal(byName['Ruhama'].mark, '✗');
  assert.equal(byName['LoE'].mark, '✗');
  assert.equal(byName['LoE'].detail, '');
  assert.equal(byName['Singapore'].mark, '✓');
  assert.equal(byName['Singapore'].detail, 'L4 + L5');
});

test('receipt: a day with nothing logged -> empty array (no empty line to render)', () => {
  assert.deepEqual(receipt(MON, events, plan), []);
});

test('receipt: emoji/order — timed rows first (schedule order), then dailies', () => {
  const rows = receipt('2026-08-30', events, plan);
  assert.equal(rows[0].name, 'Ruhama');
  assert.equal(rows[0].emoji, '✏️');
});

// review 2 fix: the paired-region boundary was ignored, so a trailing
// review/test session (the real dm3 shape — a chapter with an odd `tests`
// count, e.g. dm3-c4/c7/c11/c15 in production) fabricated a bogus lesson
// number via floor(session/2)+1 instead of reading as 'Test 1' — the exact
// bug class AGENTS.md flags repeatedly for this codebase (found before in
// session_label/_tb_wb_paired_sessions/_daily_log_note, not carried into the
// brand-new receipt()). A lone half (only textbook OR only workbook logged
// that day) also used to collapse to a bare 'L6', losing which half — fixed
// to name it explicitly instead of guessing.
const tbWbFixturePlan = sanitizePlan({
  version: 2, year: 2026,
  parentCycle: { anchorMonday: '2026-08-10', dutyStart: '2026-08-11', confirmed: true },
  periods: [],
  activities: [{ id: 'singapore', name: 'Singapore Math', type: 'paced', status: 'active',
    cls: 'other', onGrid: false, slots: [],
    chain: [{ id: 'dm3-c4', name: '3A Ch 4 · Multiplication and Division', pattern: 'tb-wb',
      lessons: 10, tests: 1, done: 21 }] }],
  overrides: [],
  log: [
    { date: '2026-09-01', activityId: 'singapore', status: 'done', curriculum: 'dm3-c4', session: 10 },   // L6 textbook alone
    { date: '2026-09-02', activityId: 'singapore', status: 'done', curriculum: 'dm3-c4', session: 13 },   // L7 workbook alone
    { date: '2026-09-03', activityId: 'singapore', status: 'done', curriculum: 'dm3-c4', session: 20 },   // trailing Test 1 (session 20 = index of the 21st session, past 10*2=20 paired)
    { date: '2026-09-04', activityId: 'singapore', status: 'done', curriculum: 'dm3-c4', session: 2 },
    { date: '2026-09-04', activityId: 'singapore', status: 'done', curriculum: 'dm3-c4', session: 3 },    // full pair, L2
  ],
});

test('receipt: a lone textbook-only session names the half — "L6 textbook", not bare "L6"', () => {
  const rows = receipt('2026-09-01', [], tbWbFixturePlan);
  assert.equal(rows[0].detail, 'L6 textbook');
});

test('receipt: a lone workbook-only session names the half — "L7 workbook"', () => {
  const rows = receipt('2026-09-02', [], tbWbFixturePlan);
  assert.equal(rows[0].detail, 'L7 workbook');
});

test('receipt: a trailing review/test session reads "Test 1", never a fabricated lesson number', () => {
  const rows = receipt('2026-09-03', [], tbWbFixturePlan);
  assert.equal(rows[0].detail, 'Test 1');
});

test('receipt: a full textbook+workbook pair still collapses to a bare lesson number', () => {
  const rows = receipt('2026-09-04', [], tbWbFixturePlan);
  assert.equal(rows[0].detail, 'L2');
});

// ── buildTimed / statusOfTimed (the pieces today.js now reuses) ──
test('buildTimed: a bot-written override renders under its own name, matching today.js\'s original behaviour', () => {
  const withOv = sanitizePlan({ ...rawPlan,
    overrides: [...rawPlan.overrides, { date: MON, action: 'add', id: 'xTest', name: 'Arya art', start: 15.5, end: 16.5 }] });
  const items = buildTimed(MON, events, withOv);
  const ov = items.find(it => it.key === 'ov:xTest');
  assert.equal(ov.name, 'Arya art');
  assert.equal(ov.eventId, 'xTest');
});

test('statusOfTimed: requires a non-null key (no cross-match on keyless rows)', () => {
  const withLog = sanitizePlan({ ...rawPlan,
    log: [...rawPlan.log, { date: MON, status: 'missed', timed: true, eventId: 'e1001' }] });
  const items = buildTimed(MON, events, withLog);
  const quran = items.find(it => it.eventId === 'e1001');
  assert.equal(statusOfTimed(withLog, MON, quran), 'missed');
  const ruhama = items.find(it => it.eventId === 'e1007');
  assert.equal(statusOfTimed(withLog, MON, ruhama), undefined);
});
