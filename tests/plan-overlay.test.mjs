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
// overlay.js only ever issues a handful of query shapes against the grid
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
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child, ref) {
    const i = this.children.indexOf(ref);
    child.parentNode = this;
    this.children.splice(i < 0 ? this.children.length : i, 0, child);
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this);
  }
  _all() {
    const out = [];
    for (const c of this.children) { out.push(c); out.push(...c._all()); }
    return out;
  }
  querySelectorAll(sel) { return this._all().filter(n => matchSel(n, sel)); }
  querySelector(sel) { return this._all().find(n => matchSel(n, sel)) || null; }
}

function makeGrid(events) {
  // <div class="grid-outer"><div id="grid">…one .evt per event, keyed by id…</div></div>
  const root = new FakeNode('body');
  const outer = new FakeNode('div');
  outer.className = 'grid-outer';
  const grid = new FakeNode('div');
  grid.id = 'grid';
  root.appendChild(outer);
  outer.appendChild(grid);
  const evtEls = {};
  for (const ev of events) {
    const el = new FakeNode('div');
    el.className = 'evt';
    el.attrs['data-id'] = ev.id;
    grid.appendChild(el);
    evtEls[ev.id] = el;
  }
  const doc = {
    getElementById: id => root._all().concat(root).find(n => n.attrs && n.attrs.id === id) || null,
    createElement: tag => new FakeNode(tag),
    querySelector: sel => root.querySelector(sel),
  };
  return { doc, grid, outer, evtEls };
}

const { store } = await import('../js/state.js');
const { plan } = await import('../js/plan/state.js');
const { applyOverlay } = await import('../js/plan/overlay.js');

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
  const { doc, evtEls } = makeGrid(store.events);
  globalThis.document = doc;

  applyOverlay();

  const d1 = dotsOf(evtEls.e1), d2 = dotsOf(evtEls.e2);
  assert.equal(d1.length, 1);
  assert.equal(d1[0].className, 'ov-dot ov-done');
  assert.equal(d1[0]._html, '✓');
  assert.equal(d2.length, 1);
  assert.equal(d2[0].className, 'ov-dot ov-partial');
  assert.equal(d2[0]._html, '◐');
});

test('applyOverlay: a log entry from last week produces no dot', () => {
  store.events = [
    { id: 'e3', cat: 'art', day: 2, start: 10, end: 11, name: 'Art' },
  ];
  loadPlan([
    { date: LAST_WEEK_SUN, eventId: 'e3', status: 'done' },  // last week's Sunday: outside the window
  ]);
  const { doc, evtEls } = makeGrid(store.events);
  globalThis.document = doc;

  applyOverlay();

  assert.equal(dotsOf(evtEls.e3).length, 0);
});

test('applyOverlay: repeated apply stays at one dot per block (idempotent sweep)', () => {
  store.events = [
    { id: 'e1', cat: 'quran', day: 0, start: 10, end: 11, name: 'Quran' },
  ];
  loadPlan([{ date: MON, eventId: 'e1', status: 'missed' }]);
  const { doc, evtEls } = makeGrid(store.events);
  globalThis.document = doc;

  applyOverlay();
  applyOverlay();
  applyOverlay();

  const dots = dotsOf(evtEls.e1);
  assert.equal(dots.length, 1);
  assert.equal(dots[0].className, 'ov-dot ov-missed');
  assert.equal(dots[0]._html, '✗');
});

test('applyOverlay: weekday-agreement guard drops a dot whose logged date no longer matches the event\'s current day', () => {
  store.events = [
    { id: 'e4', cat: 'hala', day: 2, start: 10, end: 11, name: 'Hala' },   // now lives on Wednesday
  ];
  loadPlan([
    { date: MON, eventId: 'e4', status: 'done' },   // stale: logged back when it was still on Monday
  ]);
  const { doc, evtEls } = makeGrid(store.events);
  globalThis.document = doc;

  applyOverlay();

  assert.equal(dotsOf(evtEls.e4).length, 0);
});

test('applyOverlay: two entries for the same event on different weekdays — only the one agreeing with the current day dots', () => {
  const WED = addDays(MON, 2);
  store.events = [
    { id: 'e5', cat: 'art', day: 2, start: 10, end: 11, name: 'Art' },      // currently Wednesday
  ];
  loadPlan([
    { date: MON, eventId: 'e5', status: 'missed' },  // stale Monday entry -> guard drops it
    { date: WED, eventId: 'e5', status: 'done' },     // agrees with the block's current day -> dots
  ]);
  const { doc, evtEls } = makeGrid(store.events);
  globalThis.document = doc;

  applyOverlay();

  const dots = dotsOf(evtEls.e5);
  assert.equal(dots.length, 1);
  assert.equal(dots[0].className, 'ov-dot ov-done');
});

test('applyOverlay: log entries without eventId (dailies, planner slots) stay undecorated', () => {
  store.events = [
    { id: 'e1', cat: 'quran', day: 0, start: 10, end: 11, name: 'Quran' },
  ];
  loadPlan([{ date: MON, activityId: 'some-daily', status: 'done' }]);   // no eventId
  const { doc, evtEls } = makeGrid(store.events);
  globalThis.document = doc;

  applyOverlay();

  assert.equal(dotsOf(evtEls.e1).length, 0);
});

test('applyOverlay: renders the clash banner exactly once and updates it in place on re-apply', () => {
  store.events = [];
  loadPlan([]);
  const { doc, outer } = makeGrid(store.events);
  globalThis.document = doc;

  applyOverlay();
  applyOverlay();

  // renderClashBanner only ever inserts one bar; no clashes -> empty inner html.
  const bars = outer.parentNode.children.filter(n => n.attrs.id === 'ov-clash');
  assert.equal(bars.length, 1);
  assert.equal(bars[0]._html, '');
});
