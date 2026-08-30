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
const { lastDoneEntry } = await import('../js/m.js');

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
