import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayStr, addDays, mondayOf, sanitizePlan } from '../js/plan/model.js';

// overlay.js pulls in js/state.js and js/plan/state.js, neither of which
// touches localStorage/fetch/dialogs at module scope — but every planner test
// file stubs these anyway (same rationale as tests/plan-today.test.mjs): the
// module graph must stay safe regardless of import order or future edits.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.fetch = () => Promise.resolve({ json: async () => ({}) });
for (const k of ['alert', 'confirm', 'prompt'])
  globalThis[k] = () => { throw new Error(`${k}() must never be called by the planner`); };

// ── Minimal fake DOM ─────────────────────────────────────────
// overlay.js only ever issues a handful of query shapes against its containers
// (".ov-dot", ".evt[data-id=\"X\"]", ".grid-outer") plus getElementById/
// createElement/insertBefore, so a full CSS engine would be overkill — this
// stub matches exactly what applyOverlay() and renderClashBanner() use.
function matchSel(node, sel) {
  const m = /^\.([\w-]+)(?:\[([\w-]+)="([^"]*)"\])?$/.exec(sel);
  if (!m) return false;
  const [, cls, attr, val] = m;
  if (!(node.className || '').split(/\s+/).includes(cls)) return false;
  if (attr && node.attrs[attr] !== val) return false;
  return true;
}

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.attrs = {};
    this._html = '';
  }
  get id() { return this.attrs.id; }
  set id(v) { this.attrs.id = v; }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  set textContent(v) { this._html = v; }
  appendChild(child) { child.parentNode = this; this.children.push(child); this._notify(); return child; }
  insertBefore(child, ref) {
    const i = this.children.indexOf(ref);
    child.parentNode = this;
    this.children.splice(i < 0 ? this.children.length : i, 0, child);
    this._notify();
    return child;
  }
  remove() {
    const p = this.parentNode;
    if (p) { p.children = p.children.filter(c => c !== this); p._notify(); }
  }
  // Stand-in for MutationObserver({subtree:true}) delivery: a node change
  // notifies every ancestor that has an _onMutate hook installed. Real
  // observers deliver asynchronously; the hook fires SYNCHRONOUSLY, which is
  // deliberately harsher than a browser (see the reentrancy test below).
  _notify() {
    for (let n = this; n; n = n.parentNode) if (n._onMutate) n._onMutate();
  }
  _all() {
    const out = [];
    for (const c of this.children) { out.push(c); out.push(...c._all()); }
    return out;
  }
  querySelectorAll(sel) { return this._all().filter(n => matchSel(n, sel)); }
  querySelector(sel) { return this._all().find(n => matchSel(n, sel)) || null; }
}

function evtNode(id) {
  const el = new FakeNode('div');
  el.className = 'evt';
  el.attrs['data-id'] = id;
  return el;
}

// Both render paths, exactly as index.html lays them out:
//   <div id="dayview" class="dayview">…the selected day's blocks…</div>
//   <div class="grid-outer"><div id="grid">…every weekday's blocks…</div></div>
// `dayEvents` defaults to the full set so a test can assert on both containers
// without caring which day the Day view happens to be showing.
function makeDom(events, dayEvents = events) {
  const root = new FakeNode('body');
  const dayview = new FakeNode('div');
  dayview.id = 'dayview';
  dayview.className = 'dayview';
  const outer = new FakeNode('div');
  outer.className = 'grid-outer';
  const grid = new FakeNode('div');
  grid.id = 'grid';
  root.appendChild(dayview);
  root.appendChild(outer);
  outer.appendChild(grid);

  const els = { grid: {}, day: {} };
  for (const ev of events) els.grid[ev.id] = grid.appendChild(evtNode(ev.id));
  for (const ev of dayEvents) els.day[ev.id] = dayview.appendChild(evtNode(ev.id));

  const doc = {
    getElementById: id => root._all().concat(root).find(n => n.attrs && n.attrs.id === id) || null,
    createElement: tag => new FakeNode(tag),
    querySelector: sel => root.querySelector(sel),
  };
  return { doc, root, grid, dayview, outer, els };
}

// Rebuild a container the way renderGrid()/renderDayView() do: throw the old
// blocks (dots and all) away and lay down fresh ones.
function rebuild(container, events) {
  for (const c of [...container.children]) c.remove();
  const out = {};
  for (const ev of events) out[ev.id] = container.appendChild(evtNode(ev.id));
  return out;
}

const { store } = await import('../js/state.js');
const { plan } = await import('../js/plan/state.js');
const { applyOverlay, initOverlay } = await import('../js/plan/overlay.js');

function dotsOf(el) { return el.children.filter(c => (c.className || '').split(/\s+/).includes('ov-dot')); }

function loadPlan(log) {
  plan.data = sanitizePlan({
    year: { label: 'y', start: '2026-08-17', end: '2027-08-31' },
    parentCycle: { anchorMonday: '2026-08-17', dutyStart: '2026-08-11', confirmed: true },
    periods: [], activities: [], log, overrides: [],
  });
}

const MON = mondayOf(todayStr());
const TUE = addDays(MON, 1);
const LAST_WEEK_SUN = addDays(MON, -1);       // Sunday just before this week's Monday

test('applyOverlay: entries dated Mon and Tue of the current week both produce dots in their columns', () => {
  store.events = [
    { id: 'e1', cat: 'quran', day: 0, start: 10, end: 11, name: 'Quran' },   // Monday column
    { id: 'e2', cat: 'hala', day: 1, start: 10, end: 11, name: 'Hala' },     // Tuesday column
  ];
  loadPlan([
    { date: MON, eventId: 'e1', status: 'done' },
    { date: TUE, eventId: 'e2', status: 'partial' },
  ]);
  const { doc, els } = makeDom(store.events);
  globalThis.document = doc;

  applyOverlay();

  const d1 = dotsOf(els.grid.e1), d2 = dotsOf(els.grid.e2);
  assert.equal(d1.length, 1);
  assert.equal(d1[0].className, 'ov-dot ov-done');
  assert.equal(d1[0]._html, '✓');
  assert.equal(d2.length, 1);
  assert.equal(d2[0].className, 'ov-dot ov-partial');
  assert.equal(d2[0]._html, '◐');
});

test('applyOverlay: one apply decorates BOTH #grid and #dayview (mobile Day view is a parallel render path)', () => {
  store.events = [
    { id: 'e1', cat: 'quran', day: 0, start: 10, end: 11, name: 'Quran' },
    { id: 'e2', cat: 'hala', day: 1, start: 10, end: 11, name: 'Hala' },
  ];
  loadPlan([
    { date: MON, eventId: 'e1', status: 'done' },
    { date: TUE, eventId: 'e2', status: 'missed' },
  ]);
  const { doc, els } = makeDom(store.events);
  globalThis.document = doc;

  applyOverlay();

  for (const where of ['grid', 'day']) {
    const d1 = dotsOf(els[where].e1), d2 = dotsOf(els[where].e2);
    assert.equal(d1.length, 1, `${where}: e1 dot`);
    assert.equal(d1[0].className, 'ov-dot ov-done');
    assert.equal(d1[0]._html, '✓');
    assert.equal(d2.length, 1, `${where}: e2 dot`);
    assert.equal(d2[0].className, 'ov-dot ov-missed');
    assert.equal(d2[0]._html, '✗');
  }
});

test('applyOverlay: the Day view showing one day only gets that day\'s dot (no per-day special-casing needed)', () => {
  store.events = [
    { id: 'e1', cat: 'quran', day: 0, start: 10, end: 11, name: 'Quran' },
    { id: 'e2', cat: 'hala', day: 1, start: 10, end: 11, name: 'Hala' },
  ];
  loadPlan([
    { date: MON, eventId: 'e1', status: 'done' },
    { date: TUE, eventId: 'e2', status: 'done' },
  ]);
  // Day view is parked on Tuesday, so only e2's block exists there.
  const { doc, els } = makeDom(store.events, [store.events[1]]);
  globalThis.document = doc;

  applyOverlay();

  assert.equal(dotsOf(els.day.e2).length, 1);
  assert.equal(els.day.e1, undefined);               // never rendered, nothing to decorate
  assert.equal(dotsOf(els.grid.e1).length, 1);       // still dotted on the week grid
  assert.equal(dotsOf(els.grid.e2).length, 1);
});

test('applyOverlay: a log entry from last week produces no dot', () => {
  store.events = [
    { id: 'e3', cat: 'art', day: 2, start: 10, end: 11, name: 'Art' },
  ];
  loadPlan([
    { date: LAST_WEEK_SUN, eventId: 'e3', status: 'done' },  // last week's Sunday: outside the window
  ]);
  const { doc, els } = makeDom(store.events);
  globalThis.document = doc;

  applyOverlay();

  assert.equal(dotsOf(els.grid.e3).length, 0);
  assert.equal(dotsOf(els.day.e3).length, 0);
});

test('applyOverlay: repeated apply stays at one dot per block in BOTH containers (idempotent sweep)', () => {
  store.events = [
    { id: 'e1', cat: 'quran', day: 0, start: 10, end: 11, name: 'Quran' },
  ];
  loadPlan([{ date: MON, eventId: 'e1', status: 'missed' }]);
  const { doc, els } = makeDom(store.events);
  globalThis.document = doc;

  applyOverlay();
  applyOverlay();
  applyOverlay();

  for (const where of ['grid', 'day']) {
    const dots = dotsOf(els[where].e1);
    assert.equal(dots.length, 1, `${where}: exactly one dot`);
    assert.equal(dots[0].className, 'ov-dot ov-missed');
    assert.equal(dots[0]._html, '✗');
  }
});

test('applyOverlay: the sweep clears stale dots from BOTH containers when an entry is retracted', () => {
  store.events = [
    { id: 'e1', cat: 'quran', day: 0, start: 10, end: 11, name: 'Quran' },
  ];
  loadPlan([{ date: MON, eventId: 'e1', status: 'done' }]);
  const { doc, els } = makeDom(store.events);
  globalThis.document = doc;

  applyOverlay();
  assert.equal(dotsOf(els.grid.e1).length, 1);
  assert.equal(dotsOf(els.day.e1).length, 1);

  loadPlan([]);                      // entry undone
  applyOverlay();

  assert.equal(dotsOf(els.grid.e1).length, 0);
  assert.equal(dotsOf(els.day.e1).length, 0);
});

test('applyOverlay: weekday-agreement guard drops a dot whose logged date no longer matches the event\'s current day', () => {
  store.events = [
    { id: 'e4', cat: 'hala', day: 2, start: 10, end: 11, name: 'Hala' },   // now lives on Wednesday
  ];
  loadPlan([
    { date: MON, eventId: 'e4', status: 'done' },   // stale: logged back when it was still on Monday
  ]);
  const { doc, els } = makeDom(store.events);
  globalThis.document = doc;

  applyOverlay();

  assert.equal(dotsOf(els.grid.e4).length, 0);
  assert.equal(dotsOf(els.day.e4).length, 0);       // the guard is not grid-only
});

test('applyOverlay: two entries for the same event on different weekdays — only the one agreeing with the current day dots, in both containers', () => {
  const WED = addDays(MON, 2);
  store.events = [
    { id: 'e5', cat: 'art', day: 2, start: 10, end: 11, name: 'Art' },      // currently Wednesday
  ];
  loadPlan([
    { date: MON, eventId: 'e5', status: 'missed' },  // stale Monday entry -> guard drops it
    { date: WED, eventId: 'e5', status: 'done' },     // agrees with the block's current day -> dots
  ]);
  const { doc, els } = makeDom(store.events);
  globalThis.document = doc;

  applyOverlay();

  for (const where of ['grid', 'day']) {
    const dots = dotsOf(els[where].e5);
    assert.equal(dots.length, 1, `${where}: exactly one dot`);
    assert.equal(dots[0].className, 'ov-dot ov-done');
  }
});

test('applyOverlay: log entries without eventId (dailies, planner slots) stay undecorated', () => {
  store.events = [
    { id: 'e1', cat: 'quran', day: 0, start: 10, end: 11, name: 'Quran' },
  ];
  loadPlan([{ date: MON, activityId: 'some-daily', status: 'done' }]);   // no eventId
  const { doc, els } = makeDom(store.events);
  globalThis.document = doc;

  applyOverlay();

  assert.equal(dotsOf(els.grid.e1).length, 0);
  assert.equal(dotsOf(els.day.e1).length, 0);
});

test('applyOverlay: renders the clash banner exactly once and updates it in place on re-apply', () => {
  store.events = [];
  loadPlan([]);
  const { doc, outer } = makeDom(store.events);
  globalThis.document = doc;

  applyOverlay();
  applyOverlay();

  // renderClashBanner only ever inserts one bar; no clashes -> empty inner html.
  const bars = outer.parentNode.children.filter(n => n.attrs.id === 'ov-clash');
  assert.equal(bars.length, 1);
  assert.equal(bars[0]._html, '');
});

// ── MutationObserver re-apply ────────────────────────────────
// These run last: initOverlay() installs a module-scoped observer that then
// lives for the rest of the file (it is only ever fired by hand here).
// What the stub CAN prove: the observer is registered on both containers with
// the right options, a rebuild-triggered callback re-applies the dots, bursts
// coalesce into one re-apply, self-inflicted records are drained, and a
// synchronous re-entry no-ops instead of recursing. What it CANNOT prove is
// real asynchronous record delivery and CPU behaviour over time — that is the
// 61-second browser check in the plan addendum.
// Also NOT covered here: applyOverlay's `isDragging()` early return. Flipping it
// needs an ESM module mock of the frozen js/grid.js, and `mock.module()` requires
// --experimental-test-module-mocks, which would break the mandated bare
// `node --test`. Pinned by a real pointerdown/move/up drag in the browser check
// instead (zero dot writes while the button is down) — see the plan addendum.
class FakeMutationObserver {
  static instances = [];
  constructor(cb) {
    this.cb = cb;
    this.targets = [];
    this.records = [];
    this.takeCalls = 0;
    FakeMutationObserver.instances.push(this);
  }
  observe(target, opts) { this.targets.push({ target, opts }); }
  disconnect() { this.targets = []; }
  takeRecords() { this.takeCalls++; const r = this.records; this.records = []; return r; }
  fire() { this.cb([{ type: 'childList' }], this); }
}
const flush = () => new Promise(r => queueMicrotask(r));

test('initOverlay: registers one observer on BOTH #grid and #dayview (childList + subtree)', () => {
  store.events = [{ id: 'e1', cat: 'quran', day: 0, start: 10, end: 11, name: 'Quran' }];
  loadPlan([{ date: MON, eventId: 'e1', status: 'done' }]);
  const { doc, grid, dayview } = makeDom(store.events);
  globalThis.document = doc;
  globalThis.MutationObserver = FakeMutationObserver;

  initOverlay();
  initOverlay();                                   // idempotent: never a second observer

  assert.equal(FakeMutationObserver.instances.length, 1);
  const obs = FakeMutationObserver.instances[0];
  assert.deepEqual(obs.targets.map(t => t.target), [grid, dayview]);
  for (const t of obs.targets) assert.deepEqual(t.opts, { childList: true, subtree: true });
});

test('observer: a rebuilt #dayview (day-tab tap / 60s timer) gets its dots back on the next microtask', async () => {
  const obs = FakeMutationObserver.instances[0];
  store.events = [{ id: 'e1', cat: 'quran', day: 0, start: 10, end: 11, name: 'Quran' }];
  loadPlan([{ date: MON, eventId: 'e1', status: 'done' }]);
  const { doc, dayview, els } = makeDom(store.events);
  globalThis.document = doc;

  applyOverlay();
  assert.equal(dotsOf(els.day.e1).length, 1);

  // js/dayview.js replaces #dayview's innerHTML wholesale: the dot is gone.
  const fresh = rebuild(dayview, store.events);
  assert.equal(dotsOf(fresh.e1).length, 0);

  obs.fire();
  assert.equal(dotsOf(fresh.e1).length, 0, 'not applied synchronously — coalesced to a microtask');
  await flush();

  const dots = dotsOf(fresh.e1);
  assert.equal(dots.length, 1);
  assert.equal(dots[0].className, 'ov-dot ov-done');
});

test('observer: a burst of records coalesces into a single re-apply', async () => {
  const obs = FakeMutationObserver.instances[0];
  store.events = [{ id: 'e1', cat: 'quran', day: 0, start: 10, end: 11, name: 'Quran' }];
  loadPlan([{ date: MON, eventId: 'e1', status: 'done' }]);
  const { doc, grid, dayview } = makeDom(store.events);
  globalThis.document = doc;

  rebuild(grid, store.events);
  const freshDay = rebuild(dayview, store.events);
  let applies = 0;
  grid._onMutate = () => { applies++; };            // counts dot writes, not records

  for (let i = 0; i < 25; i++) obs.fire();          // a whole-grid rebuild's worth
  await flush();

  assert.equal(applies, 1, 'exactly one dot written despite 25 firings');
  assert.equal(dotsOf(freshDay.e1).length, 1);
});

test('observer: the callback no-ops while applyOverlay is mid-flight, and self-inflicted records are drained', () => {
  const obs = FakeMutationObserver.instances[0];
  store.events = [{ id: 'e1', cat: 'quran', day: 0, start: 10, end: 11, name: 'Quran' }];
  loadPlan([{ date: MON, eventId: 'e1', status: 'done' }]);
  const { doc, grid, els } = makeDom(store.events);
  globalThis.document = doc;

  // Harsher than a browser: every dot append/removal inside #grid delivers a
  // record SYNCHRONOUSLY, straight back into the observer callback. Without
  // the `applying` guard this recurses until the stack blows.
  let fires = 0;
  grid._onMutate = () => { if (++fires <= 200) obs.fire(); };

  const before = obs.takeCalls;
  applyOverlay();

  assert.ok(fires > 0, 'the hostile hook actually fired');
  assert.ok(fires < 200, `no runaway recursion (fired ${fires}x)`);
  assert.equal(dotsOf(els.grid.e1).length, 1, 'still exactly one dot');
  assert.equal(obs.takeCalls, before + 1, 'drained its own records once per apply');
});
