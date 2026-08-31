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
const { lastDoneEntry, consequenceSentence } = await import('../js/m.js');
const { planGapDays, planDeltaChip } = await import('../js/plan/model.js');

const ACT = { id: 'singapore' };

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

test('consequenceSentence: a LATER projection reads behind, never ahead', () => {
  const txt = consequenceSentence(planGapDays(LATER, PLAN_DATE));
  assert.match(txt, /7 lessons behind/);
  assert.equal(/ahead/.test(txt), false, 'the live wording that was wrong');
});

test('consequenceSentence: behind recovers, it does not compound', () => {
  // Extra lessons ALWAYS pull the finish earlier, so when she is behind they
  // close the gap. The old sentence said "7 more and the card reads 2 wk
  // behind", which is the opposite of what another 7 lessons would do.
  const txt = consequenceSentence(planGapDays(LATER, PLAN_DATE));
  assert.match(txt, /7 more<\/b> puts her back on the plan/);
});

test('consequenceSentence: an EARLIER projection reads ahead and compounds', () => {
  const txt = consequenceSentence(planGapDays(EARLIER, PLAN_DATE));
  assert.match(txt, /7 lessons ahead of/);
  assert.match(txt, /▲ 2 wk ahead/);            // 7 days ahead + 7 more = 2 wks
});

test('consequenceSentence: dead on the plan, and a missing baseline, both say so safely', () => {
  assert.equal(consequenceSentence(0), "She's exactly on the plan right now.");
  assert.equal(consequenceSentence(null), "She's exactly on the plan right now.");
});
