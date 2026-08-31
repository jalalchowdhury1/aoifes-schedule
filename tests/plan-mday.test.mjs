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
  dayItems, dayHeader, nowBlock, subjectCards, widgetModel, widgetNext, fmtHM,
  dailyStatus, dailyVisible, buildTimed, statusOfTimed, emojiFor, colorFor,
  EMOJI_MAP, EMOJI_FALLBACK, dayState, fieldClassFor, receipt, tbWbCard,
} from '../js/plan/mday.js';

const events = JSON.parse(readFileSync(new URL('./fixtures/plan-mday-schedule.json', import.meta.url), 'utf8')).events;
const rawPlan = JSON.parse(readFileSync(new URL('./fixtures/plan-mday-plan.json', import.meta.url), 'utf8'));
const plan = sanitizePlan(rawPlan);

const MON = '2026-08-31';   // Monday — the spec's pinned test date (tomorrow relative to the fixture's "now", 2026-08-30)
const TODAY = '2026-08-30'; // the fixture's real "as of" date (streak/finish asserted against this)

// ── dayItems: 5 items, in order, for Mon Aug 31 ──────────────
// jj (Jiu Jitsu) went live as an active onGrid Monday 16-17 slot 2026-08-30 —
// it now sorts in as a THIRD timed block, ahead of the two no-slot dailies.
test('dayItems: Mon Aug 31 — 5 items, timed first (Quran, Ruhama, Jiu Jitsu) then no-slot dailies (Singapore, LoE)', () => {
  const items = dayItems(MON, events, plan);
  assert.equal(items.length, 5);
  assert.deepEqual(items.map(it => it.kind), ['timed', 'timed', 'timed', 'daily', 'daily']);

  const [quran, ruhama, jj, sm, loe] = items;
  assert.equal(quran.name, 'Quran');
  assert.equal(quran.start, 10);
  assert.equal(quran.end, 11);
  assert.equal(quran.emoji, '📖');

  assert.match(ruhama.name, /Ruhama/);
  assert.equal(ruhama.start, 11);
  assert.equal(ruhama.end, 13);
  assert.equal(ruhama.emoji, '✏️');

  assert.equal(jj.activityId, 'jj');
  assert.equal(jj.start, 16);
  assert.equal(jj.end, 17);
  assert.equal(jj.emoji, '🥋');

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
  // Log all three timed blocks (Quran, Ruhama, Jiu Jitsu) so only the two
  // dailies are left unlogged. 6pm is after Jiu Jitsu ends at 17 — the real
  // "last timed block" now that it's an active onGrid Monday slot.
  const logged = sanitizePlan({ ...rawPlan, log: [...rawPlan.log,
    { date: MON, eventId: 'e1001', status: 'done', timed: true },
    { date: MON, eventId: 'e1007', status: 'done', timed: true },
    { date: MON, activityId: 'jj', status: 'done', timed: true }] });
  const items = dayItems(MON, events, logged);
  const nb = nowBlock(MON, items, 18);            // 6pm, after Jiu Jitsu ends at 17
  assert.equal(nb.state, 'after');
  assert.equal(nb.item, null);
  assert.equal(nb.left, 2);                       // Singapore + LoE still unlogged

  const nothingLogged = nowBlock(MON, dayItems(MON, events, plan), 18);
  assert.equal(nothingLogged.left, 5);            // real fixture: nothing logged yet for a future date
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

// ── widgetModel (kept for compatibility; widgetNext below is what the
// redesigned widget actually draws) ─────────────────────────────
test('widgetModel: Mon Aug 31 — the exact strings the widget renders', () => {
  const w = widgetModel(MON, events, plan, 8);
  assert.equal(w.dayLabel, 'Today · Mon');
  assert.equal(w.first, '10:00 Quran');
  assert.equal(w.rest, '11:00 Ruhama · then Jiu Jitsu + Singapore + LoE');
  assert.equal(w.done, 0);
  assert.equal(w.total, 5);
  assert.equal(w.mama, 'Mama: work day');
});

test('widgetModel: an optional nameForEvent resolver renames the timed strings ("first"/"rest") the widget draws', () => {
  const w = widgetModel(MON, events, plan, 8, () => 'Renamed');
  assert.equal(w.first, '10:00 Renamed');
  assert.equal(w.rest, '11:00 Renamed · then Jiu Jitsu + Singapore + LoE');
});

test('widgetModel: done counts items whose status is "done"', () => {
  const withLog = sanitizePlan({ ...rawPlan,
    log: [...rawPlan.log, { date: MON, eventId: events.find(e => e.name === 'Quran' && e.day === 0).id, status: 'done', timed: true }] });
  const w = widgetModel(MON, events, withLog, 8);
  assert.equal(w.done, 1);
  assert.equal(w.total, 5);
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

// ── widgetNext (2026-08-31 redesign): what the widget actually draws —
// hours/minutes to the next-or-current class, its name, and a small "then …"
// line of what's left today. jj (Jiu Jitsu) went live as an active onGrid
// Monday 16-17 slot 2026-08-30, so it's a real timed block in these moments
// (previously 'planned'/no slots — see the fixture refresh note above).
test('widgetNext: Mon Aug 31 09:30 — next Quran at 10:00, rest lists the day\'s remaining timed blocks then the unlogged dailies', () => {
  const r = widgetNext(MON, events, plan, new Date(2026, 7, 31, 9, 30));
  assert.equal(r.mode, 'next');
  assert.equal(r.name, 'Quran');
  assert.equal(r.atLabel, '10:00');
  assert.equal(r.at, '2026-08-31T10:00:00');
  assert.deepEqual(r.rest, ['11:00 Ruhama', '4:00 Jiu Jitsu', 'Singapore', 'LoE']);
  assert.equal(r.doneCount, 0);
  assert.equal(r.total, 5);
});

test('widgetNext: Mon Aug 31 12:00 — now Ruhama until 1:00, rest drops Ruhama itself (already current, not "after")', () => {
  const r = widgetNext(MON, events, plan, new Date(2026, 7, 31, 12, 0));
  assert.equal(r.mode, 'now');
  assert.equal(r.name, 'Ruhama');
  assert.equal(r.atLabel, '1:00');
  assert.equal(r.at, '2026-08-31T13:00:00');
  assert.deepEqual(r.rest, ['4:00 Jiu Jitsu', 'Singapore', 'LoE']);
  assert.equal(r.doneCount, 0);
  assert.equal(r.total, 5);
});

// NOTE: "Mon Aug 31 17:30 -> mode 'done'" is no longer the real widgetNext
// contract — the 2026-09-01 look-ahead addition means 17:30 (every timed
// block over) now finds Tuesday's Ruhama instead; see the "today is done,
// look ahead lands on Tue Sep 1's Ruhama" test in the look-ahead section
// below, which covers this exact moment. The raw pre-look-ahead 'done'/
// 'none' shape is still covered by the 14-day-cap-exceeded test there.

test('widgetNext: Sun Aug 30 08:00 — next Ruhama at 11:00 even though it\'s already logged "missed" (time-only anchor, not status-filtered); rest is empty because both dailies are already logged for that date', () => {
  // Real fixture log for 2026-08-30: e1009 (Ruhama) logged 'missed', loe
  // logged 'missed', singapore logged done (4 sessions) — all BEFORE the
  // block's own 11am start, in this test's 8am "now". The anchor pick stays
  // time-only (current/next never look at .status — see the function's own
  // header comment), so Ruhama is still "next"; only `rest` — which DOES
  // drop anything logged — ends up empty, proving that exclusion actually
  // does something on real data (every other fixture moment above has
  // nothing logged, so it never bites there).
  const r = widgetNext(TODAY, events, plan, new Date(2026, 7, 30, 8, 0));
  assert.equal(r.mode, 'next');
  assert.equal(r.name, 'Ruhama');
  assert.equal(r.atLabel, '11:00');
  assert.equal(r.at, '2026-08-30T11:00:00');
  assert.deepEqual(r.rest, []);
  assert.equal(r.doneCount, 3);
  assert.equal(r.total, 3);
});

// ── widgetNext look-ahead (2026-09-01 addition): once today's own timed
// blocks are done (or there were none), walk forward up to 14 days for the
// next scheduled class — still mode 'next', now dated later — instead of
// flatly reporting 'done'/'none' for the rest of the day. ──────
test('widgetNext: Mon Aug 31 17:30 — today is done, look ahead lands on Tue Sep 1\'s Ruhama (11:00), rest is Tuesday\'s remaining schedule (the "Science trial" bot override + Miss Hala + the dailies)', () => {
  const r = widgetNext(MON, events, plan, new Date(2026, 7, 31, 17, 30));
  assert.equal(r.mode, 'next');
  assert.equal(r.name, 'Ruhama');
  assert.equal(r.atLabel, 'Tue 11:00');
  assert.equal(r.at, '2026-09-01T11:00:00');
  assert.deepEqual(r.rest, ['12:00 Science trial', '2:00 Miss Hala', 'Singapore', 'LoE']);
  // doneCount/total still describe TODAY (Mon), not the future day being previewed.
  assert.equal(r.doneCount, 0);
  assert.equal(r.total, 5);
});

test('widgetNext: Sun Aug 30 20:00 — no more classes today (past Ruhama, already logged), look ahead lands on tomorrow (Mon) Quran 10:00', () => {
  const r = widgetNext(TODAY, events, plan, new Date(2026, 7, 30, 20, 0));
  assert.equal(r.mode, 'next');
  assert.equal(r.name, 'Quran');
  assert.equal(r.atLabel, 'Mon 10:00');            // weekday format, pinned (not "Tomorrow 10:00")
  assert.equal(r.at, '2026-08-31T10:00:00');
  assert.deepEqual(r.rest, ['11:00 Ruhama', '4:00 Jiu Jitsu', 'Singapore', 'LoE']);
});

test('widgetNext: a date inside the Jan/Feb trip period walks straight through it — a visible reduced-travel daily never counts as "found", only a TIMED block does — landing on the first class after the trip ends', () => {
  // Real fixture period p1: 2027-01-04..2027-02-07 (travel). 2027-01-25 is a
  // Monday INSIDE the trip, so today's own timed=[] (away). Singapore
  // (travel.mode 'reduced') stays VISIBLE as a daily on every trip day —
  // dayItems('2027-01-26', ...) proves that below — but the look-ahead loop
  // only accepts `kind === 'timed'`, so it must walk past every trip day
  // (including that visible daily) and land on 2027-02-08 (Monday, the day
  // after the trip ends), exactly 14 days out — the loop's own cap boundary.
  const insideTrip = dayItems('2027-01-26', events, plan);
  assert.deepEqual(insideTrip.map(it => it.kind), ['daily']);
  assert.equal(insideTrip[0].activityId, 'singapore');

  const r = widgetNext('2027-01-25', events, plan, new Date(2027, 0, 25, 8, 0));
  assert.equal(r.mode, 'next');
  assert.equal(r.name, 'Quran');
  assert.equal(r.atLabel, 'Mon 10:00');
  assert.equal(r.at, '2027-02-08T10:00:00');
  assert.deepEqual(r.rest, ['11:00 Ruhama', '4:00 Jiu Jitsu', 'Singapore', 'LoE']);
});

test('widgetNext: nothing found within the 14-day cap falls back to the plain \'done\'/\'none\' rendering', () => {
  const emptyPlan = sanitizePlan({ version: 1, activities: [], overrides: [], log: [], periods: [] });
  const r = widgetNext(MON, [], emptyPlan, new Date(2026, 7, 31, 17, 30));
  assert.equal(r.mode, 'none');
  assert.equal(r.name, null);
  assert.equal(r.at, null);
  assert.deepEqual(r.rest, []);
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
  // Jiu Jitsu (16-17) is the real last timed block now, so all three timed
  // blocks plus both dailies need a status, checked at 6pm.
  const logged = sanitizePlan({ ...rawPlan, log: [...rawPlan.log,
    { date: MON, eventId: 'e1001', status: 'done', timed: true },
    { date: MON, eventId: 'e1007', status: 'done', timed: true },
    { date: MON, activityId: 'jj', status: 'done', timed: true },
    { date: MON, activityId: 'singapore', status: 'missed' },   // a MISS still counts as "answered"
    { date: MON, activityId: 'loe', status: 'done', curriculum: 'loe-c', session: 5 }] });
  const items = dayItems(MON, events, logged);
  const ds = dayState(items, 18);
  assert.equal(ds.phase, 'done');
  assert.equal(ds.total, 5);
  assert.equal(ds.answered, 5);
  assert.equal(fieldClassFor(ds), 'done');
});

test('dayState: after the last block, something unanswered -> phase "left" with names, violet before 18:00', () => {
  // 5:30pm: Jiu Jitsu (16-17, the real last timed block) is over but it's
  // still before the 18:00 late threshold.
  const logged = sanitizePlan({ ...rawPlan, log: [...rawPlan.log,
    { date: MON, eventId: 'e1001', status: 'done', timed: true },
    { date: MON, eventId: 'e1007', status: 'done', timed: true }] });
  const items = dayItems(MON, events, logged);
  const ds = dayState(items, 17.5);
  assert.equal(ds.phase, 'left');
  assert.equal(ds.left, 3);
  assert.deepEqual(ds.names.sort(), ['Jiu Jitsu', 'Logic of English', 'Singapore Math'].sort());
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

// ── tbWbCard: the phone's Singapore lesson card, as a pure model ──
// The card used to be two buttons that BOTH meant "advance whatever's next",
// with the violet highlight showing which one that was. On a real phone
// (2026-08-31) that read as "textbook is selected", so the next tap on
// Workbook looked like a second choice and was in fact an undo. The model
// below gives every half its OWN session index and its own done/next/undoable
// state, so a button says what it is rather than what's next.
const smAct = (chain, log = []) => ({
  act: { id: 'singapore', name: 'Singapore Math', type: 'paced', status: 'active', chain },
  log,
});
const CH1 = done => ({ id: 'dm3-c1', name: '3A Ch 1 · Numbers to 10,000',
  pattern: 'tb-wb', lessons: 11, tests: 0, done });
const CARD_DAY = '2026-08-31';
const cardFor = (done, log = [], extra = false) => {
  const chain = [CH1(done)];
  const { act } = smAct(chain, log);
  return tbWbCard(act, chain[0], log, CARD_DAY, extra);
};
const row = (session, date = CARD_DAY) => ({ date, activityId: 'singapore',
  status: 'done', curriculum: 'dm3-c1', session });

test('tbWbCard: a fresh day offers the current lesson with BOTH halves open', () => {
  const c = cardFor(10);
  assert.equal(c.chapter, '3A Ch 1');
  assert.equal(c.lessons.length, 1);
  assert.equal(c.lessons[0].lesson, 6);
  assert.deepEqual(c.lessons[0].halves.map(h => h.label), ['Textbook', 'Workbook']);
  assert.deepEqual(c.lessons[0].halves.map(h => h.done), [false, false]);
  assert.deepEqual(c.lessons[0].halves.map(h => h.next), [true, false]);
  assert.equal(c.lessons[0].halves[1].needs, 'Textbook');       // workbook waits its turn
  assert.equal(c.addLesson, null);
});

test('tbWbCard: after the textbook tap the WORKBOOK is next — the textbook stays ticked', () => {
  const c = cardFor(11, [row(10)]);
  const [tb, wb] = c.lessons[0].halves;
  assert.equal(c.lessons[0].lesson, 6);
  assert.deepEqual([tb.done, wb.done], [true, false]);
  assert.deepEqual([tb.next, wb.next], [false, true]);
  assert.equal(tb.undoable, true);                              // logged today
  assert.equal(c.addLesson, null);
});

test('tbWbCard: both halves ticked -> the lesson stays on screen, the NEXT one is gated behind ➕', () => {
  const c = cardFor(12, [row(10), row(11)]);
  assert.equal(c.lessons.length, 1);
  assert.equal(c.lessons[0].lesson, 6);
  assert.deepEqual(c.lessons[0].halves.map(h => h.done), [true, true]);
  assert.equal(c.addLesson, 7);
});

test('tbWbCard: ➕ opens lesson 7 while lesson 6 keeps its ✓✓ — two lessons in one day', () => {
  const c = cardFor(12, [row(10), row(11)], true);
  assert.deepEqual(c.lessons.map(l => l.lesson), [6, 7]);
  assert.deepEqual(c.lessons[1].halves.map(h => h.done), [false, false]);
  assert.equal(c.lessons[1].halves[0].next, true);
  assert.equal(c.addLesson, null);
});

test('tbWbCard: a second lesson half-logged stays open without ➕ being re-tapped', () => {
  const c = cardFor(13, [row(10), row(11), row(12)]);
  assert.deepEqual(c.lessons.map(l => l.lesson), [6, 7]);
  assert.deepEqual(c.lessons[1].halves.map(h => h.done), [true, false]);
});

test('tbWbCard: a half logged on an EARLIER day shows ticked but is not undoable here', () => {
  const c = cardFor(11, [row(10, '2026-08-30')]);
  const [tb, wb] = c.lessons[0].halves;
  assert.equal(tb.done, true);
  assert.equal(tb.loggedOn, '2026-08-30');
  assert.equal(tb.undoable, false);
  assert.equal(wb.next, true);                                  // today finishes the pair
});

test('tbWbCard: nothing logged today for THIS chapter but a lesson finished in the last one -> still gated', () => {
  const chain = [{ ...CH1(22) }, { id: 'dm3-c2', name: '3A Ch 2 · Addition',
    pattern: 'tb-wb', lessons: 8, tests: 1, done: 0 }];
  const log = [row(20), row(21)];                               // finished Ch 1 today
  const c = tbWbCard({ id: 'singapore', chain }, chain[1], log, CARD_DAY);
  assert.equal(c.chapter, '3A Ch 2');
  assert.equal(c.lessons.length, 0);
  assert.equal(c.addLesson, 1);
});

test('tbWbCard: past the paired region it is a REVIEW button, never a fabricated lesson 11', () => {
  const chain = [{ id: 'dm3-c4', name: '3A Ch 4 · Multiplication', pattern: 'tb-wb',
    lessons: 10, tests: 1, done: 20 }];
  const c = tbWbCard({ id: 'singapore', chain }, chain[0], [], CARD_DAY);
  assert.deepEqual(c.lessons, []);
  assert.equal(c.tests.length, 1);
  assert.equal(c.tests[0].label, 'Test 1');
  assert.equal(c.tests[0].next, true);
  assert.equal(c.currentLabel, 'Test 1');
  assert.equal(c.totalSessions, 21);
});

test('tbWbCard: the pace line reads the CURRENT lesson and the chapter\'s real session total', () => {
  const c = cardFor(11, [row(10)]);
  assert.equal(c.currentLabel, 'L6');
  assert.equal(c.doneSessions, 11);
  assert.equal(c.totalSessions, 22);
});

test('tbWbCard: a count-pending chapter (no lessons loaded yet) renders nothing', () => {
  const chain = [{ id: 'dm3', name: 'Dimensions Math G3', pattern: 'tb-wb',
    lessons: 0, tests: 0, done: 0 }];
  assert.equal(tbWbCard({ id: 'singapore', chain }, chain[0], [], CARD_DAY), null);
});

test('tbWbCard: full labels are sessionLabel\'s own strings, so a toast names the lesson', () => {
  const c = cardFor(12, [row(10), row(11)], true);
  assert.equal(c.lessons[1].halves[0].fullLabel, 'Lesson 7 · textbook');
  assert.equal(c.lessons[1].halves[1].fullLabel, 'Lesson 7 · workbook');
});

test('subjectCards: carries the PACE gap, not just the date-derived week delta', () => {
  const p = sanitizePlan({
    version: 2, periods: [],
    parentCycle: { anchorMonday: '2026-08-17', dutyStart: '2026-08-11', confirmed: true },
    activities: [{ id: 'singapore', name: 'Singapore Math', type: 'paced', status: 'active',
      rhythm: { kind: 'daily', sessionsPerDay: 2 }, travel: { mode: 'reduced', factor: 0.5 },
      baseline: { setOn: '2026-08-28', rows: { 'dm3-c1': '2026-12-27' } },
      chain: [{ id: 'dm3-c1', pattern: 'tb-wb', lessons: 11, tests: 0, done: 12 }] }],
    overrides: [],
    log: [...Array(2).fill('2026-08-28'), ...Array(4).fill('2026-08-29'),
          ...Array(4).fill('2026-08-30'), ...Array(2).fill('2026-08-31')]
      .map(date => ({ date, activityId: 'singapore', status: 'done', curriculum: 'dm3-c1', session: 0 })),
  });
  const card = subjectCards(p, '2026-08-31').find(c => c.id === 'singapore');
  assert.equal(card.pace.lessons, 2, '12 sessions logged against 8 the plan expected');
  assert.equal(card.pace.done, 12);
  assert.equal(card.pace.expected, 8);
});
