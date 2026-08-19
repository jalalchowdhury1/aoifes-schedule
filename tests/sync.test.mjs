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
const { initLiveSync, runSync, SYNC_MS } = await import('../js/plan/tabs.js');

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

test('syncPlan: a POST that REJECTS still releases the counter (finally, not then)', async () => {
  P.initPlan();
  fetchImpl = () => Promise.reject(new Error('offline'));
  P.savePlan();
  await tick();
  fetchImpl = () => Promise.resolve(res(planBlob({ savedAt: NEW, overrides: [ONEOFF] })));
  assert.equal(await P.syncPlan(), true);               // not wedged by the failed save
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
  const at = P.syncInfo.at;
  fetchImpl = () => Promise.reject(new Error('offline'));
  const { r, rendered } = await applied(P.syncPlan);
  assert.equal(r, false);
  assert.equal(rendered, 0);
  assert.equal(serializePlan(P.plan.data), before);
  assert.equal(P.syncInfo.at, at, 'an offline round must not claim freshness');
});

test('syncPlan: an error payload is ignored, but the round still counts as reached', async () => {
  P.initPlan();
  const before = serializePlan(P.plan.data);
  P.syncInfo.at = null;
  fetchImpl = () => Promise.resolve(res({ error: 'no-kv' }));
  assert.equal(await P.syncPlan(), false);
  assert.equal(serializePlan(P.plan.data), before);
  assert.ok(P.syncInfo.at, 'the server answered: the caption may say so');
});

test('syncPlan: syncInfo.at advances on a round that applies nothing (the caption is freshness, not change)', async () => {
  P.initPlan();
  const blob = planBlob({ savedAt: NEW });
  fetchImpl = () => Promise.resolve(res(blob));
  await P.syncPlan();
  P.syncInfo.at = null;
  assert.equal(await P.syncPlan(), false);              // identical: nothing applied
  assert.ok(P.syncInfo.at, 'still heard from KV');
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
SCHED.holdSync(() => dragging);

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

// ── the scheduler: js/plan/tabs.js ──────────────────────────
function fakeEnv(visibility = 'visible') {
  const handlers = { doc: {}, win: {} };
  let intervalMs = null, intervalFn = null;
  const env = {
    doc: { visibilityState: visibility,
           addEventListener: (k, fn) => { handlers.doc[k] = fn; } },
    win: { addEventListener: (k, fn) => { handlers.win[k] = fn; } },
    every: (fn, ms) => { intervalFn = fn; intervalMs = ms; },
  };
  return { env, handlers, poll: () => intervalFn(), ms: () => intervalMs };
}

test('initLiveSync: wires visibilitychange + focus + a 120s poll', () => {
  const { env, handlers, ms } = fakeEnv();
  initLiveSync(() => {}, env);
  assert.ok(handlers.doc.visibilitychange);
  assert.ok(handlers.win.focus);
  assert.equal(ms(), SYNC_MS);
  assert.equal(SYNC_MS, 120000);
});

test('initLiveSync: a hidden tab never polls and never syncs on visibilitychange', () => {
  const { env, handlers, poll } = fakeEnv('hidden');
  let runs = 0;
  initLiveSync(() => { runs++; }, env);
  poll();
  handlers.doc.visibilitychange();
  assert.equal(runs, 0, 'a phone on the fridge must not poll KV all day');
  handlers.win.focus();
  assert.equal(runs, 1, 'focus is the one trigger that always means "someone is here"');
});

test('initLiveSync: a visible tab syncs on poll, on becoming visible, and on focus', () => {
  const { env, handlers, poll } = fakeEnv('visible');
  let runs = 0;
  initLiveSync(() => { runs++; }, env);
  poll();
  handlers.doc.visibilitychange();
  handlers.win.focus();
  assert.equal(runs, 3);
});

test('runSync: one round drives BOTH blobs and resolves even when everything is offline', async () => {
  SCHED.store.events = [...EV];
  await settled();
  const urls = [];
  fetchImpl = url => { urls.push(String(url)); return Promise.reject(new Error('offline')); };
  await runSync();                                      // must resolve, never reject
  assert.deepEqual(urls.sort(), ['/api/get', '/api/plan-get']);
});
