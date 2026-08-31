// Server-side merge for concurrent plan writes (planner-v2.5).
// This is the last line of defence for the family's log: the browser guard
// stops a tab overwriting itself, this stops two DIFFERENT writers (a tab and
// the Telegram bot) from erasing each other inside the same 120s window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergePlanWrites, sanitizePlan } from '../js/plan/model.js';

const D = '2026-08-18';
const base = (over = {}) => ({
  version: 1,
  year: { label: '2026-27', start: '2026-08-17', end: '2027-08-31' },
  parentCycle: { pattern: '7on7off', anchorMonday: '2026-08-17', dutyStart: '2026-08-11', confirmed: true },
  periods: [], activities: [], log: [], overrides: [], savedAt: '2026-08-18T10:00:00.000Z',
  ...over,
});
const loe = (done = 3) => ({
  id: 'loe', type: 'paced', name: 'Logic of English', status: 'active',
  chain: [{ id: 'loe-c', pattern: 'simple', firstUnit: 1, lastUnit: 40, done }],
});

test('append vs append: BOTH writers survive (the whole point)', () => {
  // The bot wrote a one-off while the tab had the page open; the tab then saves
  // a blob that predates it, carrying its own fresh tap.
  const current = base({
    overrides: [{ id: 'x1', date: D, action: 'add', start: 15, end: 16, name: 'Arya art' }],
    log: [{ date: D, eventId: 'x1', status: 'done', timed: true }],
  });
  const incoming = base({
    log: [{ date: D, eventId: 'e1', status: 'done', timed: true }],
    savedAt: '2026-08-18T10:05:00.000Z',
  });

  const out = mergePlanWrites(current, incoming);

  assert.deepEqual(out.overrides.map(o => o.id), ['x1'], 'the bot\'s one-off is kept');
  assert.deepEqual(out.log.map(e => e.eventId), ['e1', 'x1'], 'both taps survive');
  assert.equal(out.savedAt, '2026-08-18T10:05:00.000Z', 'the writer\'s stamp wins');
  // Pure: neither input is touched.
  assert.equal(current.log.length, 1);
  assert.equal(incoming.log.length, 1);
});

test('no-op when the incoming blob already contains everything', () => {
  const current = base({ log: [{ date: D, eventId: 'e1', status: 'done' }] });
  const incoming = base({
    log: [{ date: D, eventId: 'e1', status: 'partial' }],      // same row, newer status
    savedAt: '2026-08-18T10:05:00.000Z',
  });
  const out = mergePlanWrites(current, incoming);
  assert.equal(out, incoming, 'returns the very same object: the caller writes it unchanged');
  assert.deepEqual(out.log.map(e => e.status), ['partial'], 'a re-tap is an update, not a duplicate');
});

test('log identity is (date, owner): same event on another day is a different row', () => {
  const current = base({ log: [
    { date: D, eventId: 'e1', status: 'done' },
    { date: '2026-08-19', eventId: 'e1', status: 'done' },
    { date: D, activityId: 'loe', status: 'done' },
  ] });
  const incoming = base({ log: [{ date: D, eventId: 'e1', status: 'missed' }],
                          savedAt: '2026-08-18T10:05:00.000Z' });
  const out = mergePlanWrites(current, incoming);
  assert.deepEqual(out.log, [
    { date: D, eventId: 'e1', status: 'missed' },
    { date: '2026-08-19', eventId: 'e1', status: 'done' },
    { date: D, activityId: 'loe', status: 'done' },
  ]);
});

test('a carried-over paced check replays its curriculum increment', () => {
  // The tab ticked Logic of English: that write bumped chain.done AND logged the
  // row. If only the row came back, the chain would sit one session behind.
  const current = base({
    activities: [loe(4)],
    log: [{ date: D, activityId: 'loe', status: 'done', curriculum: 'loe-c', session: 3 }],
  });
  const incoming = base({ activities: [loe(3)], savedAt: '2026-08-18T10:05:00.000Z' });

  const out = mergePlanWrites(current, incoming);

  assert.equal(out.activities[0].chain[0].done, 4);
  assert.equal(incoming.activities[0].chain[0].done, 3, 'incoming is not mutated');
  assert.equal(out.log.length, 1);
});

test('two carried-over checks bump twice; an unknown curriculum bumps nothing', () => {
  const current = base({
    activities: [loe(5)],
    log: [
      { date: D, activityId: 'loe', status: 'done', curriculum: 'loe-c' },
      { date: '2026-08-19', activityId: 'loe', status: 'done', curriculum: 'loe-c' },
      { date: '2026-08-20', activityId: 'loe', status: 'done', curriculum: 'gone' },
      { date: '2026-08-21', activityId: 'ghost', status: 'done', curriculum: 'loe-c' },
    ],
  });
  const incoming = base({ activities: [loe(3)], savedAt: '2026-08-18T10:05:00.000Z' });
  const out = mergePlanWrites(current, incoming);
  assert.equal(out.activities[0].chain[0].done, 5, '3 + two real bumps');
  assert.equal(out.log.length, 4, 'every row is still carried over');
});

test('a paced row with no activityId finds its curriculum by chain id', () => {
  const current = base({
    activities: [loe(4)],
    log: [{ date: D, activityId: undefined, eventId: 'x1', status: 'done', curriculum: 'loe-c' }],
  });
  const incoming = base({ activities: [loe(3)], savedAt: '2026-08-18T10:05:00.000Z' });
  const out = mergePlanWrites(current, incoming);
  assert.equal(out.activities[0].chain[0].done, 4);
});

test('overrides: id is identity; an id-less row falls back to its fingerprint', () => {
  const row = { date: D, action: 'add', start: 15, end: 16, name: 'Arya art' };
  const current = base({ overrides: [{ ...row }, { ...row, name: 'Dentist', start: 9 }] });
  const incoming = base({ overrides: [{ ...row }], savedAt: '2026-08-18T10:05:00.000Z' });
  const out = mergePlanWrites(current, incoming);
  assert.equal(out.overrides.length, 2, 'the identical row is not duplicated');
  assert.deepEqual(out.overrides.map(o => o.name), ['Arya art', 'Dentist']);
});

test('an edited override (same id, new time) keeps the incoming version only', () => {
  const current = base({ overrides: [{ id: 'x1', date: D, action: 'add', start: 15, end: 16, name: 'Arya art' }] });
  const incoming = base({
    overrides: [{ id: 'x1', date: D, action: 'add', start: 16, end: 17, name: 'Arya art' }],
    savedAt: '2026-08-18T10:05:00.000Z',
  });
  const out = mergePlanWrites(current, incoming);
  assert.equal(out.overrides.length, 1);
  assert.equal(out.overrides[0].start, 16, 'the newer write wins the row it owns');
});

test('KNOWN LIMIT, pinned: a deletion that races another write is resurrected', () => {
  // The family unticked a status (log splice) while the bot wrote a one-off.
  // The untick loses: the row comes back. Documented in AGENTS.md; the family
  // re-taps. Pinned as a TEST so the behaviour can never change silently.
  const current = base({ log: [{ date: D, eventId: 'e1', status: 'done' }] });
  const incoming = base({ log: [], savedAt: '2026-08-18T10:05:00.000Z' });
  const out = mergePlanWrites(current, incoming);
  assert.deepEqual(out.log, [{ date: D, eventId: 'e1', status: 'done' }]);
});

test('incoming wins outright on everything that is not overrides or log', () => {
  const current = base({
    periods: [{ id: 'p1', start: '2027-01-04', end: '2027-01-10', type: 'travel' }],
    parentCycle: { pattern: '7on7off', anchorMonday: '2026-08-17', dutyStart: '2026-08-11', confirmed: true },
    activities: [loe(9)],
    log: [{ date: D, eventId: 'e1', status: 'done' }],       // forces the merge path
  });
  const incoming = base({ periods: [], activities: [loe(3)], savedAt: '2026-08-18T10:05:00.000Z' });
  const out = mergePlanWrites(current, incoming);
  assert.deepEqual(out.periods, [], 'a deleted trip stays deleted');
  assert.equal(out.activities[0].chain[0].done, 3, 'no bump: the row carries no curriculum');
});

test('junk in, incoming out: never throws, never invents a blob', () => {
  const incoming = base();
  assert.equal(mergePlanWrites(null, incoming), incoming);
  assert.equal(mergePlanWrites('nonsense', incoming), incoming);
  assert.equal(mergePlanWrites(base(), null), null);
  assert.equal(mergePlanWrites(base(), undefined), undefined);
  const weird = mergePlanWrites({ log: 'not an array', overrides: 7 }, incoming);
  assert.equal(weird, incoming);
});

test('the merged blob still passes sanitizePlan unchanged', () => {
  const current = base({
    overrides: [{ id: 'x1', date: D, action: 'add', start: 15, end: 16, name: 'Arya art' }],
    log: [{ date: D, eventId: 'x1', status: 'done', timed: true }],
    activities: [loe(4)],
  });
  const incoming = base({ activities: [loe(3)], log: [{ date: D, eventId: 'e1', status: 'done' }],
                          savedAt: '2026-08-18T10:05:00.000Z' });
  const out = mergePlanWrites(current, incoming);
  assert.deepEqual(sanitizePlan(JSON.parse(JSON.stringify(out))), sanitizePlan(out));
  assert.equal(sanitizePlan(out).log.length, 2);
});

// The endpoint is the only consumer; if it ever stops importing the canonical
// implementation (e.g. someone inlines a copy for a runtime that cannot resolve
// the import), this test fails loudly instead of the two drifting in silence.
test('api/plan-save.js uses the canonical model implementation', () => {
  const src = readFileSync(new URL('../api/plan-save.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ mergePlanWrites \} from '\.\.\/js\/plan\/model\.js'/);
  assert.match(src, /mergePlanWrites\(stored, incoming\)/);
  assert.equal(/function mergePlanWrites/.test(src), false, 'no inlined copy to drift');
});

// ── multi-session days (2026-08-31) ─────────────────────────
// A tb-wb lesson is TWO log rows on one date, and a double-lesson day is
// four. Keyed on `date|owner` alone, every row after the first collapsed into
// the first — so a phone that logged the textbook half while the bot logged
// the workbook half kept ONE of them and the chapter counter went one session
// short. Session rows are therefore identified by WHICH session they are;
// markers and timed rows keep the old one-per-day identity, so the bot's ✗
// marker still does not resurrect itself over a tab's real session row.
const sm = (done = 10) => ({
  id: 'singapore', type: 'paced', name: 'Singapore Math', status: 'active',
  chain: [{ id: 'dm3-c1', pattern: 'tb-wb', lessons: 11, tests: 0, done }],
});
const sess = (session, date = D) => ({ date, activityId: 'singapore',
  status: 'done', curriculum: 'dm3-c1', session });

test('two DIFFERENT sessions on one day both survive, and both bump the chapter', () => {
  const current = base({ activities: [sm(11)], log: [sess(10)] });     // the textbook half
  const incoming = base({ activities: [sm(11)], log: [sess(11)],       // the workbook half
    savedAt: '2026-08-18T10:05:00.000Z' });

  const out = mergePlanWrites(current, incoming);

  assert.deepEqual(out.log.map(e => e.session).sort((a, b) => a - b), [10, 11]);
  assert.equal(out.activities[0].chain[0].done, 12, 'the carried row replays its own bump');
});

test('the SAME session written twice is still one row (no double count)', () => {
  const current = base({ activities: [sm(11)], log: [sess(10)] });
  const incoming = base({ activities: [sm(11)], log: [sess(10)],
    savedAt: '2026-08-18T10:05:00.000Z' });

  const out = mergePlanWrites(current, incoming);

  assert.equal(out.log.length, 1);
  assert.equal(out.activities[0].chain[0].done, 11, 'no phantom extra session');
});

test('four sessions (a double-lesson day) survive a merge intact', () => {
  const current = base({ activities: [sm(14)], log: [sess(10), sess(11), sess(12), sess(13)] });
  const incoming = base({ activities: [sm(10)], log: [], savedAt: '2026-08-18T10:05:00.000Z' });

  const out = mergePlanWrites(current, incoming);

  assert.deepEqual(out.log.map(e => e.session), [10, 11, 12, 13]);
  assert.equal(out.activities[0].chain[0].done, 14);
});

test('a bot ✗ marker does NOT resurrect over a tab\'s real session row', () => {
  const current = base({ activities: [sm(10)],
    log: [{ date: D, activityId: 'singapore', status: 'missed' }] });
  const incoming = base({ activities: [sm(11)], log: [sess(10)],
    savedAt: '2026-08-18T10:05:00.000Z' });

  const out = mergePlanWrites(current, incoming);

  assert.equal(out.log.length, 1, 'the marker stays dropped, exactly as before');
  assert.equal(out.log[0].status, 'done');
  assert.equal(out.activities[0].chain[0].done, 11);
});

test('real work is never dropped in favour of an incoming marker', () => {
  // The inverse race: the tab is saving a ✗ marker while KV already holds the
  // day's logged sessions. The merge's own rule — a resurrected tick is
  // visible and re-fixable, a silently deleted session is neither — says the
  // sessions come back; dailyStatus then shows the marker and "Clear ✗
  // marker" resolves it in place.
  const current = base({ activities: [sm(12)], log: [sess(10), sess(11)] });
  const incoming = base({ activities: [sm(10)],
    log: [{ date: D, activityId: 'singapore', status: 'missed' }],
    savedAt: '2026-08-18T10:05:00.000Z' });

  const out = mergePlanWrites(current, incoming);

  assert.equal(out.log.length, 3);
  assert.equal(out.activities[0].chain[0].done, 12);
});
