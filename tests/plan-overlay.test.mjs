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
// (".ov-dot", ".ov-oneoff", ".ca", ".evt[data-id=\"X\"]", ".grid-outer") plus
// getElementById/createElement/insertBefore/get-setAttribute and inline styles,
// so a full CSS engine would be overkill — this stub matches exactly what
// applyOverlay(), applyOneOffs() and renderClashBanner() use.
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
    this.style = {};              // inline styles: what overlay.js reads AND writes
    this._html = '';
  }
  get id() { return this.attrs.id; }
  set id(v) { this.attrs.id = v; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
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
//   <div id="dayview" class="dayview">…the selected day's column…</div>
//   <div class="grid-outer"><div id="grid">…seven columns…</div></div>
// Each column is a `.ca[data-day]` whose inline height is (E-S)*ph, exactly as
// js/grid.js and js/dayview.js draw it — that height is how overlay.js recovers
// pixels-per-hour (66 on the grid, 62 in the Day view) without importing either
// frozen module. `dayEvents` defaults to the full set so a dot test can assert
// on both containers without caring which day the Day view is showing.
const SPAN = 17 - 9;              // E - S, the drawn band
const GRID_PH = 66, DAY_PH = 62;  // js/model.js SPH, js/dayview.js DPH

function caNode(day, ph) {
  const ca = new FakeNode('div');
  ca.className = 'ca';
  ca.attrs['data-day'] = String(day);
  ca.style.height = `${SPAN * ph}px`;
  return ca;
}

function makeDom(events, dayEvents = events, dayviewDay = dayEvents[0]?.day ?? 0) {
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

  const cols = {};
  for (let d = 0; d < 7; d++) cols[d] = grid.appendChild(caNode(d, GRID_PH));
  const dayCol = dayview.appendChild(caNode(dayviewDay, DAY_PH));

  const els = { grid: {}, day: {}, cols, dayCol };
  for (const ev of events) els.grid[ev.id] = cols[ev.day ?? 0].appendChild(evtNode(ev.id));
  for (const ev of dayEvents) els.day[ev.id] = dayCol.appendChild(evtNode(ev.id));

  const doc = {
    getElementById: id => root._all().concat(root).find(n => n.attrs && n.attrs.id === id) || null,
    createElement: tag => new FakeNode(tag),
    querySelector: sel => root.querySelector(sel),
  };
  return { doc, root, grid, dayview, outer, els, cols, dayCol };
}

// Rebuild a container the way renderGrid()/renderDayView() do: throw the old
// column away (blocks, dots, ghosts and all) and lay down a fresh one.
function rebuild(container, events, ph = DAY_PH, day = events[0]?.day ?? 0) {
  for (const c of [...container.children]) c.remove();
  const ca = container.appendChild(caNode(day, ph));
  const out = {};
  for (const ev of events) out[ev.id] = ca.appendChild(evtNode(ev.id));
  return out;
}

const { store } = await import('../js/state.js');
const { plan } = await import('../js/plan/state.js');
const { applyOverlay, initOverlay } = await import('../js/plan/overlay.js');

function dotsOf(el) { return el.children.filter(c => (c.className || '').split(/\s+/).includes('ov-dot')); }

function loadPlan(log, overrides = [], activities = []) {
  plan.data = sanitizePlan({
    year: { label: 'y', start: '2026-08-17', end: '2027-08-31' },
    parentCycle: { anchorMonday: '2026-08-17', dutyStart: '2026-08-11', confirmed: true },
    periods: [], activities, log, overrides,
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

// ── One-off (dated) blocks ───────────────────────────────────
// A dated override is what the Telegram bot writes ("Arya art 3pm Wednesday").
// It is not part of the recurring template, so it renders as a read-only ghost
// in the column for its date — on the week grid AND in the Day view, which is
// what the family actually looks at on a phone (standing directive).
const WED = addDays(MON, 2);
const NEXT_WED = addDays(MON, 9);
const ghostsOf = el => el.querySelectorAll('.ov-oneoff');
const artOneOff = (over = {}) =>
  ({ id: 'x1', date: WED, action: 'add', start: 15, end: 16, name: 'Arya art', ...over });

test('one-off: this week\'s dated override renders as a ghost in its own column, in BOTH #grid and #dayview', () => {
  store.events = [];
  loadPlan([], [artOneOff()]);
  const { doc, grid, dayview, cols, dayCol } = makeDom([], [], 2);   // Day view parked on Wednesday
  globalThis.document = doc;

  applyOverlay();

  const g = ghostsOf(grid), d = ghostsOf(dayview);
  assert.equal(g.length, 1);
  assert.equal(d.length, 1);
  assert.equal(g[0].parentNode, cols[2], 'week grid: Wednesday column');
  assert.equal(d[0].parentNode, dayCol, 'day view: the rendered column');
  // Positioned off the column's own height, so each container gets its own
  // pixels-per-hour: 3pm–4pm is (15-9)*ph + 1 with a (1h * ph) - 2 body.
  assert.equal(g[0].style.top, `${(15 - 9) * GRID_PH + 1}px`);
  assert.equal(g[0].style.height, `${GRID_PH - 2}px`);
  assert.equal(d[0].style.top, `${(15 - 9) * DAY_PH + 1}px`);
  assert.equal(d[0].style.height, `${DAY_PH - 2}px`);
  // Reuses .evt for layout, adds .ov-oneoff for the dashed neutral treatment.
  assert.equal(g[0].className, 'evt ov-oneoff');
  assert.match(g[0].innerHTML, /Arya art/);
  assert.match(g[0].innerHTML, /3pm&ndash;4pm/);
  assert.match(g[0].innerHTML, /one-off/);
  // NOT data-id: that attribute is the template's identity and the dot sweep
  // queries it — a ghost must never be mistaken for a draggable event.
  assert.equal(g[0].getAttribute('data-oneoff'), 'x1');
  assert.equal(g[0].getAttribute('data-id'), null);
});

test('one-off: a Day view parked on another day shows no ghost, while the week grid still does', () => {
  store.events = [];
  loadPlan([], [artOneOff()]);
  const { doc, grid, dayview } = makeDom([], [], 0);          // Day view on Monday
  globalThis.document = doc;

  applyOverlay();

  assert.equal(ghostsOf(grid).length, 1);
  assert.equal(ghostsOf(dayview).length, 0);
});

test('one-off: an override outside the current week never renders', () => {
  store.events = [];
  loadPlan([], [artOneOff({ id: 'x2', date: NEXT_WED }), artOneOff({ id: 'x3', date: LAST_WEEK_SUN })]);
  const { doc, grid, dayview } = makeDom([], [], 2);
  globalThis.document = doc;

  applyOverlay();

  assert.equal(ghostsOf(grid).length, 0);
  assert.equal(ghostsOf(dayview).length, 0);
});

test('one-off: a logged one-off carries its status dot (eventId === the override id)', () => {
  store.events = [];
  loadPlan([{ date: WED, eventId: 'x1', status: 'done' }], [artOneOff()]);
  const { doc, grid, dayview } = makeDom([], [], 2);
  globalThis.document = doc;

  applyOverlay();

  for (const [where, root] of [['grid', grid], ['dayview', dayview]]) {
    const dots = dotsOf(ghostsOf(root)[0]);
    assert.equal(dots.length, 1, `${where}: one dot`);
    assert.equal(dots[0].className, 'ov-dot ov-done');
    assert.equal(dots[0]._html, '✓');
  }
});

test('one-off: an unlogged one-off, and an entry logged on another date, get no dot', () => {
  store.events = [];
  loadPlan([{ date: addDays(WED, 1), eventId: 'x1', status: 'missed' }], [artOneOff()]);
  const { doc, grid } = makeDom([], [], 2);
  globalThis.document = doc;

  applyOverlay();

  assert.equal(dotsOf(ghostsOf(grid)[0]).length, 0);
});

test('one-off: repeated apply stays at exactly one ghost per container (idempotent sweep)', () => {
  store.events = [];
  loadPlan([{ date: WED, eventId: 'x1', status: 'partial' }], [artOneOff()]);
  const { doc, grid, dayview } = makeDom([], [], 2);
  globalThis.document = doc;

  applyOverlay();
  applyOverlay();
  applyOverlay();

  for (const [where, root] of [['grid', grid], ['dayview', dayview]]) {
    const g = ghostsOf(root);
    assert.equal(g.length, 1, `${where}: exactly one ghost`);
    assert.equal(dotsOf(g[0]).length, 1, `${where}: exactly one dot on it`);
  }
  // The ghost's own dot leaves with the ghost: no orphans anywhere.
  assert.equal(grid.querySelectorAll('.ov-dot').length, 1);
});

test('one-off: a retracted override disappears on the next sweep', () => {
  store.events = [];
  loadPlan([], [artOneOff()]);
  const { doc, grid, dayview } = makeDom([], [], 2);
  globalThis.document = doc;

  applyOverlay();
  assert.equal(ghostsOf(grid).length, 1);

  loadPlan([], []);
  applyOverlay();

  assert.equal(ghostsOf(grid).length, 0);
  assert.equal(ghostsOf(dayview).length, 0);
});

test('one-off: skips and timeless overrides never draw a block', () => {
  store.events = [];
  loadPlan([], [
    { id: 'x4', date: WED, action: 'skip', eventId: 'e1' },
    { id: 'x5', date: WED, action: 'add' },                       // no times: Today-list only
    { id: 'x6', date: WED, action: 'add', start: 15, end: 15 },   // zero length
    { id: 'x7', date: WED, action: 'add', start: '15', end: '16' }, // strings, not hours
  ]);
  const { doc, grid } = makeDom([], [], 2);
  globalThis.document = doc;

  applyOverlay();

  assert.equal(ghostsOf(grid).length, 0);
});

test('one-off: an out-of-band block is dropped, an overhanging one is clamped to the drawn grid', () => {
  store.events = [];
  loadPlan([], [
    { id: 'x8', date: WED, action: 'add', start: 7, end: 8.5, name: 'Before school' },   // ends before 9
    { id: 'x9', date: WED, action: 'add', start: 16, end: 19, name: 'Long evening' },    // runs past 5pm
  ]);
  const { doc, grid } = makeDom([], [], 2);
  globalThis.document = doc;

  applyOverlay();

  const g = ghostsOf(grid);
  assert.equal(g.length, 1, 'the fully-outside one is dropped, not squashed onto 9am');
  assert.equal(g[0].style.top, `${(16 - 9) * GRID_PH + 1}px`);
  assert.equal(g[0].style.height, `${(17 - 16) * GRID_PH - 2}px`, 'clamped at the 5pm edge');
  assert.match(g[0].innerHTML, /4pm&ndash;7pm/, 'the label still states the real times');
});

test('one-off: the name is escaped and falls back to the activity it makes up for', () => {
  store.events = [];
  loadPlan([], [
    { id: 'x10', date: WED, action: 'add', start: 10, end: 11, activityId: 'loe' },
    { id: 'x11', date: WED, action: 'add', start: 12, end: 13, name: '<img src=x onerror=alert(1)>' },
  ], [{ id: 'loe', type: 'paced', name: 'Logic of English' }]);
  const { doc, grid } = makeDom([], [], 2);
  globalThis.document = doc;

  applyOverlay();

  const [a, b] = ghostsOf(grid);
  assert.match(a.innerHTML, /Logic of English/);
  assert.match(b.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(b.innerHTML.includes('<img'), false);
});

test('one-off: a ghost never gets a template dot, and a template block never gets a ghost\'s', () => {
  store.events = [{ id: 'x1', cat: 'quran', day: 2, start: 9, end: 10, name: 'Quran' }];
  // Pathological: a template event whose id collides with the override's id.
  loadPlan([{ date: WED, eventId: 'x1', status: 'done' }], [artOneOff()]);
  const { doc, grid, els } = makeDom(store.events, [], 2);
  globalThis.document = doc;

  applyOverlay();

  assert.equal(dotsOf(els.grid.x1).length, 1, 'the template block is decorated by the dot sweep');
  assert.equal(dotsOf(ghostsOf(grid)[0]).length, 1, 'the ghost carries its own, from its own lookup');
  assert.equal(grid.querySelectorAll('.evt[data-id="x1"]').length, 1, 'the ghost is not queryable as an event');
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
