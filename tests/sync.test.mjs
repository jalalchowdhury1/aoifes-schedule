// Live re-sync guards (planner-v2.5). These protect LIVE family data: the rule
// is "show what the bot wrote, never overwrite what we just wrote", so every
// branch of both guards is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializePlan } from '../js/plan/model.js';

// Both stores touch localStorage / fetch / document at commit time; stub the
// globals BEFORE importing them (same rationale as tests/plan-state.test.mjs).
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { dispatchEvent: () => {}, getElementById: () => null,
                        addEventListener: () => {}, visibilityState: 'visible' };
globalThis.window = { addEventListener: () => {} };
for (const k of ['alert', 'confirm', 'prompt'])
  globalThis[k] = () => { throw new Error(`${k}() must never be called by the planner`); };

// One switchable fetch: each test installs the response it wants to model.
let fetchImpl = () => Promise.reject(new Error('no fetch stub installed'));
globalThis.fetch = (...a) => fetchImpl(...a);
const res = (body, ok = true) => ({ ok, json: async () => body });
const tick = () => new Promise(r => setTimeout(r, 0));

const SCHED = await import('../js/state.js');
const P = await import('../js/plan/state.js');
const SYNC = await import('../js/sync.js');
const { initLiveSync, runSync, inputFocused, SYNC_MS, WAKE_MS } = await import('../js/plan/tabs.js');
// initLiveSync wires exactly once per module instance (one interval per page),
// so each scheduler test imports its own copy of tabs.js. Its imports — the two
// stores — resolve to the SAME instances, which is the point.
const freshTabs = () => import(`../js/plan/tabs.js?n=${Math.random()}`);
const clearMarks = () => { SYNC.syncInfo.plan = null; SYNC.syncInfo.schedule = null; };

const OLD = '2000-01-01T00:00:00.000Z';
const NEW = '2099-01-01T00:00:00.000Z';

const planBlob = (over = {}) => ({
  version: 1,
  year: { label: '2026-27', start: '2026-08-17', end: '2027-08-31' },
  parentCycle: { pattern: '7on7off', anchorMonday: '2026-08-17', dutyStart: '2026-08-11', confirmed: true },
  periods: [], activities: [], log: [], overrides: [],
  ...over,
});
const ONEOFF = { id: 'x1', date: '2026-08-19', action: 'add', start: 15, end: 16, name: 'Arya art' };

// planNotify listeners are a Set with no removal, so register ONE counter for
// the whole file and read deltas around each call.
let notified = 0;
P.onPlanChange(() => { notified++; });
const applied = async fn => { const n = notified; const r = await fn(); return { r, rendered: notified - n }; };

// ── planner blob: js/plan/state.js ──────────────────────────
test('syncPlan: a newer remote blob is applied and re-renders once', async () => {
  P.initPlan();
  fetchImpl = () => Promise.resolve(res(planBlob({ savedAt: NEW, overrides: [ONEOFF] })));
  const { r, rendered } = await applied(P.syncPlan);
  assert.equal(r, true);
  assert.equal(rendered, 1);
  assert.deepEqual(P.plan.data.overrides, [ONEOFF]);
});

test('syncPlan: an identical blob is dropped before the re-render (never fight scroll/typing)', async () => {
  P.initPlan();
  const blob = planBlob({ savedAt: NEW, overrides: [ONEOFF] });
  fetchImpl = () => Promise.resolve(res(blob));
  await P.syncPlan();                                   // first round applies it
  const { r, rendered } = await applied(P.syncPlan);    // same bytes again
  assert.equal(r, false);
  assert.equal(rendered, 0);
  assert.deepEqual(P.plan.data.overrides, [ONEOFF]);
});

test('syncPlan: a save in flight blocks application, and the counter never latches', async () => {
  P.initPlan();
  let releasePost;
  fetchImpl = () => new Promise(r => { releasePost = () => r(res({ ok: true })); });
  P.savePlan();                                         // POST hangs: pendingSaves === 1
  fetchImpl = () => Promise.resolve(res(planBlob({ savedAt: NEW, overrides: [ONEOFF] })));
  const { r, rendered } = await applied(P.syncPlan);
  assert.equal(r, false, 'a blob fetched mid-write may predate our own write');
  assert.equal(rendered, 0);
  assert.deepEqual(P.plan.data.overrides, []);

  releasePost();                                        // the POST lands
  await tick();
  assert.equal(await P.syncPlan(), true, 'counter released: the same blob now applies');
  assert.deepEqual(P.plan.data.overrides, [ONEOFF]);
});

test('syncPlan: a POST that REJECTS still releases the counter, and the tap is REPLAYED not dropped', async () => {
  P.initPlan();
  P.plan.data.log.push({ date: '2026-09-01', activityId: 'loe', status: 'done' });
  fetchImpl = () => Promise.reject(new Error('offline'));
  P.savePlan();                                         // never reaches KV
  await tick();

  // Next round: the failed write is re-published FIRST, and nothing is applied
  // over it. This is the self-heal — an offline tap used to be discarded.
  const posted = [];
  fetchImpl = (url, opt) => {
    if (String(url).includes('plan-save')) { posted.push(JSON.parse(opt.body)); return Promise.resolve(res({ ok: true })); }
    return Promise.resolve(res(planBlob({ savedAt: NEW, overrides: [ONEOFF] })));
  };
  assert.equal(await P.syncPlan(), false, 'the retry round reads nothing');
  assert.equal(posted.length, 1, 'it re-published the local blob');
  assert.match(posted[0].data, /"activityId":"loe"/, 'the same bytes, tap included');

  // and the round after that syncs normally again
  assert.equal(await P.syncPlan(), true);
  assert.deepEqual(P.plan.data.overrides, [ONEOFF]);
});

test('syncPlan: a remote blob OLDER than our own last save is ignored', async () => {
  P.initPlan();
  fetchImpl = () => Promise.resolve(res({ ok: true }));
  P.savePlan();                                         // stamps lastLocalSaveAt = now
  await tick();
  const before = serializePlan(P.plan.data);
  fetchImpl = () => Promise.resolve(res(planBlob({ savedAt: OLD, overrides: [ONEOFF] })));
  const { r, rendered } = await applied(P.syncPlan);
  assert.equal(r, false);
  assert.equal(rendered, 0);
  assert.equal(serializePlan(P.plan.data), before, 'our own write survives the stale read');
});

test('isAtLeast: timestamps compare as EPOCHS, not strings (bot microseconds vs browser milliseconds)', () => {
  // The bot's Python stamps 6 fractional digits, this browser stamps 3. Within
  // the same millisecond '…12.345678Z' sorts BELOW '…12.345Z' as a string
  // ('6' < 'Z'), so a string compare rejects a bot write that is in fact the
  // newer one — the family's tap on Telegram would never reach the open tab.
  const mine = '2026-08-18T10:00:12.345Z';
  const bot  = '2026-08-18T10:00:12.345678Z';
  assert.ok(bot < mine, 'string compare gets this exactly backwards');
  assert.equal(P.isAtLeast(bot, mine), true, 'same millisecond: not older');
  assert.equal(P.isAtLeast('2026-08-18T10:00:11.999999Z', mine), false, 'genuinely older');
  assert.equal(P.isAtLeast('2026-08-18T10:00:13.000001Z', mine), true);
  assert.equal(P.isAtLeast(mine, mine), true);                      // equal counts
  assert.equal(P.isAtLeast(undefined, mine), false);
  assert.equal(P.isAtLeast('not a date', mine), false);
  assert.equal(P.isAtLeast(mine, 'not a date'), false);
  // Offset form vs Z form: same instant, still >=.
  assert.equal(P.isAtLeast('2026-08-18T06:00:12.345-04:00', mine), true);
});

test('syncPlan: a microsecond-stamped bot write in our own millisecond is APPLIED, not rejected', async () => {
  P.initPlan();
  let stamped = null;
  fetchImpl = (url, opt) => {
    if (String(url).includes('plan-save')) { stamped = JSON.parse(JSON.parse(opt.body).data).savedAt; return Promise.resolve(res({ ok: true })); }
    return Promise.resolve(res({ error: 'empty' }));
  };
  P.savePlan();
  await tick();
  const botStamp = stamped.replace(/Z$/, '678Z');      // same ms, µs precision
  assert.ok(botStamp < stamped, 'the string trap this guards');
  fetchImpl = () => Promise.resolve(res(planBlob({ savedAt: botStamp, overrides: [ONEOFF] })));
  assert.equal(await P.syncPlan(), true);
  assert.deepEqual(P.plan.data.overrides, [ONEOFF]);
});

test('syncPlan: after a local save, a remote blob with no savedAt is treated as older', async () => {
  P.initPlan();
  fetchImpl = () => Promise.resolve(res({ ok: true }));
  P.savePlan();
  await tick();
  const before = serializePlan(P.plan.data);
  fetchImpl = () => Promise.resolve(res(planBlob({ overrides: [ONEOFF] })));   // no savedAt
  assert.equal(await P.syncPlan(), false);
  assert.equal(serializePlan(P.plan.data), before);
});

test('syncPlan: with no local save yet, a blob with no savedAt IS applied (fresh tab)', async () => {
  P.initPlan();
  const fresh = await import(`../js/plan/state.js?fresh=${Date.now()}`);   // no lastLocalSaveAt
  fresh.initPlan();
  fetchImpl = () => Promise.resolve(res(planBlob({ overrides: [ONEOFF] })));
  assert.equal(await fresh.syncPlan(), true);
  assert.deepEqual(fresh.plan.data.overrides, [ONEOFF]);
});

test('syncPlan: a fetch error leaves the plan untouched and reports no sync', async () => {
  P.initPlan();
  const before = serializePlan(P.plan.data);
  clearMarks();
  fetchImpl = () => Promise.reject(new Error('offline'));
  const { r, rendered } = await applied(P.syncPlan);
  assert.equal(r, false);
  assert.equal(rendered, 0);
  assert.equal(serializePlan(P.plan.data), before);
  assert.equal(SYNC.syncInfo.plan, null, 'an offline round must not claim freshness');
});

test('syncPlan: an error payload is ignored, but the round still counts as reached', async () => {
  P.initPlan();
  const before = serializePlan(P.plan.data);
  clearMarks();
  fetchImpl = () => Promise.resolve(res({ error: 'no-kv' }));
  assert.equal(await P.syncPlan(), false);
  assert.equal(serializePlan(P.plan.data), before);
  assert.ok(SYNC.syncInfo.plan, 'the server answered: the caption may say so');
});

test('the freshness mark advances on a round that applies nothing (the caption is freshness, not change)', async () => {
  P.initPlan();
  const blob = planBlob({ savedAt: NEW });
  fetchImpl = () => Promise.resolve(res(blob));
  await P.syncPlan();
  clearMarks();
  assert.equal(await P.syncPlan(), false);              // identical: nothing applied
  assert.ok(SYNC.syncInfo.plan, 'still heard from KV');
});

test('syncPlan: an empty KV is seeded once, never after a local save', async () => {
  const fresh = await import(`../js/plan/state.js?seed=${Date.now()}`);
  fresh.initPlan();
  let posts = 0;
  fetchImpl = (url) => {
    if (String(url).includes('plan-save')) { posts++; return Promise.resolve(res({ ok: true })); }
    return Promise.resolve(res({ error: 'empty' }));
  };
  await fresh.syncPlan();
  assert.equal(posts, 1, 'first run publishes the seed');
  await tick();
  await fresh.syncPlan();
  assert.equal(posts, 1, 'a wiped KV is never re-seeded over what this tab has written');
});

// ── schedule template: js/state.js ──────────────────────────
const EV = [{ id: 'e1', cat: 'quran', day: 0, start: 10, end: 11, note: '', name: '' }];
const EV2 = [{ id: 'e7', cat: 'art', day: 3, start: 14, end: 15, note: '', name: 'Art' }];

let renders = 0;
SCHED.onChange(() => { renders++; });
const rendered = async fn => { const n = renders; const r = await fn(); return { r, rendered: renders - n }; };

// The template guard has no timestamp to lean on, so a successful save is what
// proves KV holds what we hold. Every test starts from that known-good state.
async function settled() {
  fetchImpl = () => Promise.resolve(res({ ok: true }));
  SCHED.save();
  await tick();
}

let dragging = false;
SYNC.holdSync(() => dragging);
SYNC.holdSync(() => inputFocused());        // exactly what js/plan/tabs.js registers

test('syncSchedule: a differing remote blob is applied, re-renders once, and re-seeds the id counter', async () => {
  SCHED.store.events = [...EV];
  await settled();
  fetchImpl = () => Promise.resolve(res({ events: EV2, altSun: true, catLabels: { quran: 'Qur’an' } }));
  const out = await rendered(SCHED.syncSchedule);
  assert.equal(out.r, true);
  assert.equal(out.rendered, 1);
  assert.deepEqual(SCHED.store.events, EV2);
  assert.equal(SCHED.store.altSun, true);
  assert.equal(SCHED.uid(), 'e8', 'next id continues past the fetched blob');
});

test('syncSchedule: an identical blob never re-renders', async () => {
  SCHED.store.events = [...EV];
  SCHED.store.altSun = false;
  SCHED.store.catLabels = {};
  await settled();
  fetchImpl = () => Promise.resolve(res({ events: EV, altSun: false, catLabels: {} }));
  const out = await rendered(SCHED.syncSchedule);
  assert.equal(out.r, false);
  assert.equal(out.rendered, 0);
});

test('syncSchedule: a save in flight blocks application (a mid-write read may be the pre-image)', async () => {
  SCHED.store.events = [...EV];
  await settled();
  let releasePost;
  fetchImpl = () => new Promise(r => { releasePost = () => r(res({ ok: true })); });
  SCHED.save();                                         // POST hangs
  fetchImpl = () => Promise.resolve(res({ events: EV2 }));
  const out = await rendered(SCHED.syncSchedule);
  assert.equal(out.r, false);
  assert.equal(out.rendered, 0);
  assert.deepEqual(SCHED.store.events, EV, 'the family\'s own edit stands');

  releasePost();
  await tick();
  assert.equal(await SCHED.syncSchedule(), true, 'and applies once the write has landed');
});

test('syncSchedule: a FAILED save keeps local authoritative until one lands', async () => {
  SCHED.store.events = [...EV];
  await settled();
  fetchImpl = () => Promise.reject(new Error('offline'));
  SCHED.save();                                         // never reaches KV
  await tick();
  fetchImpl = () => Promise.resolve(res({ events: EV2 }));
  assert.equal(await SCHED.syncSchedule(), false, 'local is ahead of KV: applying would lose the edit');
  assert.deepEqual(SCHED.store.events, EV);

  await settled();                                      // a save lands: flag clears
  fetchImpl = () => Promise.resolve(res({ events: EV2 }));
  assert.equal(await SCHED.syncSchedule(), true);
  assert.deepEqual(SCHED.store.events, EV2);
});

test('syncSchedule: an HTTP error on save counts as failed, not saved', async () => {
  SCHED.store.events = [...EV];
  await settled();
  fetchImpl = () => Promise.resolve(res({ error: 'no-kv' }, false));   // ok:false
  SCHED.save();
  await tick();
  fetchImpl = () => Promise.resolve(res({ events: EV2 }));
  assert.equal(await SCHED.syncSchedule(), false);
  assert.deepEqual(SCHED.store.events, EV);
  await settled();
});

test('syncSchedule: a registered hold (drag/resize, open editor) blocks application', async () => {
  SCHED.store.events = [...EV];
  await settled();
  dragging = true;
  fetchImpl = () => Promise.resolve(res({ events: EV2 }));
  const out = await rendered(SCHED.syncSchedule);
  assert.equal(out.r, false);
  assert.equal(out.rendered, 0);
  assert.deepEqual(SCHED.store.events, EV);

  dragging = false;                                     // drop ends: no latch
  assert.equal(await SCHED.syncSchedule(), true);
});

test('syncSchedule: fetch error and error payloads leave the store untouched', async () => {
  SCHED.store.events = [...EV];
  await settled();
  for (const impl of [
    () => Promise.reject(new Error('offline')),
    () => Promise.resolve(res({ error: 'empty' })),
    () => Promise.resolve(res({ error: 'no-kv' })),
    () => Promise.resolve(res(null)),
  ]) {
    fetchImpl = impl;
    const out = await rendered(SCHED.syncSchedule);
    assert.equal(out.r, false);
    assert.equal(out.rendered, 0);
    assert.deepEqual(SCHED.store.events, EV);
  }
});

test('syncSchedule: a blob missing keys keeps the current values for them', async () => {
  SCHED.store.events = [...EV];
  SCHED.store.altSun = true;
  SCHED.store.catLabels = { art: 'Art with Ayra' };
  await settled();
  fetchImpl = () => Promise.resolve(res({ events: EV2 }));       // no altSun / catLabels
  assert.equal(await SCHED.syncSchedule(), true);
  assert.equal(SCHED.store.altSun, true);
  assert.deepEqual(SCHED.store.catLabels, { art: 'Art with Ayra' });
});

test('syncSchedule: a failed save is RE-PUBLISHED on the next round, then normal sync resumes', async () => {
  SCHED.store.events = [...EV];
  await settled();
  SCHED.store.events = [...EV, { id: 'e9', cat: 'art', day: 5, start: 9, end: 10, note: '', name: 'New' }];
  fetchImpl = () => Promise.reject(new Error('offline'));
  SCHED.save();                                         // the family's edit, lost in the wire
  await tick();

  const posted = [];
  fetchImpl = (url, opt) => {
    if (String(url).includes('/api/save')) { posted.push(JSON.parse(opt.body).data); return Promise.resolve(res({ ok: true })); }
    return Promise.resolve(res({ events: EV }));        // KV still has the OLD blob
  };
  const out = await rendered(SCHED.syncSchedule);
  assert.equal(out.r, false, 'the retry round applies nothing');
  assert.equal(out.rendered, 0);
  assert.equal(posted.length, 1, 're-published instead of going stale forever');
  assert.match(posted[0], /"id":"e9"/, 'the edit that failed is the one that went up');
  assert.equal(SCHED.store.events.length, 2, 'and it was never overwritten by the old blob');

  // KV is now in sync again, so the NEXT round reads normally.
  fetchImpl = () => Promise.resolve(res({ events: EV2 }));
  assert.equal(await SCHED.syncSchedule(), true);
  assert.deepEqual(SCHED.store.events, EV2);
});

test('syncSchedule: a retry that fails again keeps retrying and never applies', async () => {
  SCHED.store.events = [...EV];
  await settled();
  fetchImpl = () => Promise.reject(new Error('offline'));
  SCHED.save();
  await tick();
  let posts = 0;
  fetchImpl = url => {
    if (String(url).includes('/api/save')) { posts++; return Promise.reject(new Error('still offline')); }
    return Promise.resolve(res({ events: EV2 }));
  };
  assert.equal(await SCHED.syncSchedule(), false);
  assert.equal(await SCHED.syncSchedule(), false);
  assert.equal(posts, 2, 'every round is another attempt');
  assert.deepEqual(SCHED.store.events, EV, 'never clobbered while local is ahead');
  await settled();
});

// ── the focused-input hold covers BOTH stores ───────────────
test('inputFocused: true only for a focused field', () => {
  const doc = tag => ({ activeElement: tag ? { tagName: tag } : null });
  assert.equal(inputFocused(doc('INPUT')), true);
  assert.equal(inputFocused(doc('SELECT')), true);
  assert.equal(inputFocused(doc('TEXTAREA')), true);
  assert.equal(inputFocused(doc('BUTTON')), false);
  assert.equal(inputFocused(doc('DIV')), false);
  assert.equal(inputFocused(doc(null)), false);
  assert.equal(inputFocused({}), false);
  assert.equal(inputFocused(undefined), false);
});

test('a focused field holds BOTH stores (the Year sheet types into the planner blob)', async () => {
  SCHED.store.events = [...EV];
  await settled();
  P.initPlan();
  globalThis.document.activeElement = { tagName: 'INPUT' };     // mid-edit
  fetchImpl = () => Promise.resolve(res(planBlob({ savedAt: NEW, overrides: [ONEOFF] })));
  assert.equal(await P.syncPlan(), false, 'planner sync waits');
  fetchImpl = () => Promise.resolve(res({ events: EV2 }));
  assert.equal(await SCHED.syncSchedule(), false, 'template sync waits');
  assert.deepEqual(P.plan.data.overrides, []);
  assert.deepEqual(SCHED.store.events, EV);

  globalThis.document.activeElement = null;                     // blur: no latch
  fetchImpl = () => Promise.resolve(res(planBlob({ savedAt: NEW, overrides: [ONEOFF] })));
  assert.equal(await P.syncPlan(), true);
  fetchImpl = () => Promise.resolve(res({ events: EV2 }));
  assert.equal(await SCHED.syncSchedule(), true);
});

// ── caption honesty: the older of the two rounds ────────────
test('syncedAt: null until BOTH blobs have been heard from, then the OLDER one', () => {
  clearMarks();
  assert.equal(SYNC.syncedAt(), null);
  SYNC.markSynced('plan', '2026-08-18T14:00:00.000Z');
  assert.equal(SYNC.syncedAt(), null, 'a fresh planner over an unknown template proves nothing');
  SYNC.markSynced('schedule', '2026-08-18T13:00:00.000Z');
  assert.equal(SYNC.syncedAt(), '2026-08-18T13:00:00.000Z', 'the page is only as fresh as its stalest half');
  SYNC.markSynced('schedule', '2026-08-18T15:00:00.000Z');
  assert.equal(SYNC.syncedAt(), '2026-08-18T14:00:00.000Z');
  clearMarks();
});

// ── the scheduler: js/plan/tabs.js ──────────────────────────
function fakeEnv(visibility = 'visible', now = () => Date.now()) {
  const handlers = { doc: {}, win: {} };
  let intervalMs = null, intervalFn = null;
  const env = {
    doc: { visibilityState: visibility,
           addEventListener: (k, fn) => { handlers.doc[k] = fn; } },
    win: { addEventListener: (k, fn) => { handlers.win[k] = fn; } },
    every: (fn, ms) => { intervalFn = fn; intervalMs = ms; },
    now,
  };
  return { env, handlers, poll: () => intervalFn(), ms: () => intervalMs };
}

test('initLiveSync: wires visibilitychange + focus + a 120s poll', async () => {
  const { env, handlers, ms } = fakeEnv();
  const T = await freshTabs();
  assert.equal(T.initLiveSync(() => {}, env), true);
  assert.ok(handlers.doc.visibilitychange);
  assert.ok(handlers.win.focus);
  assert.equal(ms(), SYNC_MS);
  assert.equal(SYNC_MS, 120000);
});

test('initLiveSync: a second call never wires a second interval', async () => {
  const T = await freshTabs();
  const one = fakeEnv(), two = fakeEnv();
  assert.equal(T.initLiveSync(() => {}, one.env), true);
  assert.equal(T.initLiveSync(() => {}, two.env), false, 'idempotent');
  assert.equal(two.ms(), null, 'no timer from the second call');
  assert.equal(two.handlers.win.focus, undefined);
});

test('initLiveSync: a hidden tab never polls and never syncs on visibilitychange', async () => {
  const { env, handlers, poll } = fakeEnv('hidden');
  let runs = 0;
  const T = await freshTabs();
  T.initLiveSync(() => { runs++; }, env);
  poll();
  handlers.doc.visibilitychange();
  assert.equal(runs, 0, 'a phone on the fridge must not poll KV all day');
  handlers.win.focus();
  assert.equal(runs, 1, 'focus is the one trigger that always means "someone is here"');
});

test('initLiveSync: a visible tab syncs on poll, on becoming visible, and on focus', async () => {
  const clock = { t: 0 };
  const { env, handlers, poll } = fakeEnv('visible', () => clock.t);
  let runs = 0;
  const T = await freshTabs();
  T.initLiveSync(() => { runs++; }, env);
  // Each round has to SETTLE before the next trigger counts (a round already in
  // flight swallows one) — three separate wakes, not one burst.
  poll();                       await tick();
  clock.t += WAKE_MS;
  handlers.doc.visibilitychange(); await tick();
  clock.t += WAKE_MS;
  handlers.win.focus();         await tick();
  assert.equal(runs, 3);
});

test('initLiveSync: one wake = one round (visibilitychange + focus fire together)', async () => {
  const clock = { t: 5000 };
  const { env, handlers } = fakeEnv('visible', () => clock.t);
  let runs = 0;
  const T = await freshTabs();
  T.initLiveSync(() => { runs++; }, env);

  handlers.doc.visibilitychange();          // a phone unlocking fires BOTH,
  await tick();                             // milliseconds apart
  clock.t += 3;
  handlers.win.focus();
  await tick();
  assert.equal(runs, 1, 'the second is swallowed by the wake window');

  clock.t += WAKE_MS;                       // a genuinely later wake still runs
  handlers.win.focus();
  await tick();
  assert.equal(runs, 2);
});

test('initLiveSync: a round still running swallows the next trigger', async () => {
  const clock = { t: 0 };
  const { env, handlers } = fakeEnv('visible', () => clock.t);
  let runs = 0, release;
  const T = await freshTabs();
  T.initLiveSync(() => { runs++; return new Promise(r => { release = r; }); }, env);
  handlers.win.focus();
  clock.t += 10 * WAKE_MS;                  // long past the debounce window
  handlers.win.focus();
  assert.equal(runs, 1, 'no overlapping rounds');
  release();
  await tick();
  clock.t += WAKE_MS;
  handlers.win.focus();
  assert.equal(runs, 2, 'and it runs again once the first has settled');
});

test('runSync: one round drives BOTH blobs and resolves even when everything is offline', async () => {
  SCHED.store.events = [...EV];
  await settled();
  const urls = [];
  fetchImpl = url => { urls.push(String(url)); return Promise.reject(new Error('offline')); };
  await runSync();                                      // must resolve, never reject
  assert.deepEqual(urls.sort(), ['/api/get', '/api/plan-get']);
});
