import { test } from 'node:test';
import assert from 'node:assert/strict';

// grid.js imports js/state.js and js/plan/state.js; neither touches the DOM at
// module scope, but stub the browser globals exactly like the other planner
// tests so the import graph stays safe regardless of order.
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.fetch = () => Promise.resolve({ json: async () => ({}) });
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
for (const k of ['alert', 'confirm', 'prompt'])
  globalThis[k] = () => { throw new Error(`${k}() must never be called by the planner`); };

const { blockRef, slotHTML, initGrid } = await import('../js/grid.js');
const { store } = await import('../js/state.js');
const { plan } = await import('../js/plan/state.js');

test('blockRef: data-id is a template event, data-slot is a planner slot, neither is null', () => {
  assert.deepEqual(blockRef({ id: 'e1010' }), { kind: 'event', id: 'e1010' });
  assert.deepEqual(blockRef({ slot: 'geography:0' }), { kind: 'slot', actId: 'geography', idx: 0 });
  assert.deepEqual(blockRef({ slot: 'my:odd:id:12' }), { kind: 'slot', actId: 'my:odd:id', idx: 12 });
  assert.equal(blockRef({}), null);
  assert.equal(blockRef(undefined), null);
});

test('blockRef: data-id wins when both are present; malformed data-slot is null', () => {
  assert.deepEqual(blockRef({ id: 'e1', slot: 'geography:0' }), { kind: 'event', id: 'e1' });
  assert.equal(blockRef({ slot: 'geography' }), null);
  assert.equal(blockRef({ slot: ':0' }), null);
  assert.equal(blockRef({ slot: 'geography:x' }), null);
  assert.equal(blockRef({ slot: 'geography:-1' }), null);
});

test('slotHTML: positions by the clamped band, labels the real times, carries data-slot and no data-id', () => {
  const b = { actId: 'geography', idx: 0, day: 2, start: 8, end: 10, top: 9, bottom: 10,
              name: 'Geography', cls: 'g', note: 'Introduction to Geography' };
  const html = slotHTML(b, 66, { handle: true });
  assert.match(html, /class="evt g pslot"/);
  assert.match(html, /data-slot="geography:0"/);
  assert.doesNotMatch(html, /data-id/);
  assert.match(html, /top:1px;height:64px/);            // (9-9)*66+1, (10-9)*66-2
  assert.match(html, /8am&ndash;10am/);
  assert.match(html, /Introduction to Geography/);      // 64px > 46 → note shown
  assert.match(html, /class="rh"/);
  assert.doesNotMatch(slotHTML(b, 66, { handle: false }), /class="rh"/);
});

test('slotHTML: escapes the name and the actId', () => {
  const b = { actId: 'a<b', idx: 1, day: 0, start: 9, end: 10, top: 9, bottom: 10, name: '<Sci & Co>', cls: 's', note: '' };
  const html = slotHTML(b, 66);
  assert.match(html, /data-slot="a&lt;b:1"/);
  assert.match(html, /&lt;Sci &amp; Co&gt;/);
});

test('slotHTML: a skipped block gets the pslot-skip class and the skipped tag; an unskipped one gets neither', () => {
  const b = { actId: 'geography', idx: 0, day: 2, start: 11, end: 12, top: 11, bottom: 12,
              name: 'Geography', cls: 'g', note: '', skipped: '2026-08-19' };
  const html = slotHTML(b, 66);
  assert.match(html, /class="evt g pslot pslot-skip"/);
  assert.match(html, /<span class="ov-tag">skipped<\/span>/);
  const unskipped = slotHTML({ ...b, skipped: null }, 66);
  assert.doesNotMatch(unskipped, /pslot-skip/);
  assert.doesNotMatch(unskipped, /ov-tag/);
});

// ── grid click: a slot deselects the template block's editor (red-team M5) ──
// A click on a .pslot used to be a pure no-op — the previously selected
// template block's editor stayed open over an unrelated tap.
function fakeEvt(dataset) {
  return { dataset, closest: sel => (sel === '.evt' ? { dataset } : null) };
}

test('grid click: an unlocked tap on a .pslot deselects the previously selected template block', () => {
  const listeners = {};
  const savedDoc = globalThis.document;
  globalThis.document = { getElementById: id => (id === 'grid' ? { addEventListener: (t, fn) => { listeners[t] = fn; } } : null) };
  try {
    initGrid();
    store.locked = false;
    store.selId = 'e1';
    listeners.click({ target: fakeEvt({ slot: 'geography:0' }) });
    assert.equal(store.selId, null);
    // Nothing selected -> a slot tap stays a harmless no-op (still null).
    listeners.click({ target: fakeEvt({ slot: 'geography:0' }) });
    assert.equal(store.selId, null);
  } finally {
    globalThis.document = savedDoc;
  }
});

// ── slot drag: a no-move drop skips the pointless full-blob POST (red-team L2) ──
// Drives the REAL pointerdown/pointermove/pointerup handlers through a fake
// grid + document so a slot dragged away and back to its exact original
// {day,start,end} is proven to never call setSlot (spied via localStorage
// writes, which only ever happen through commit()).
test('grid drag: a slot dropped back at its original position never POSTs; a genuine move still does', () => {
  const savedDoc = globalThis.document;
  const savedMM = globalThis.matchMedia;
  const savedLS = globalThis.localStorage;
  let writes = 0;
  globalThis.matchMedia = () => ({ matches: true, addEventListener() {} });  // allow drag in this test only
  globalThis.localStorage = { getItem: () => null, setItem: () => { writes++; } };
  const cas = [0, 1, 2, 3, 4, 5, 6].map(i => ({
    getBoundingClientRect: () => ({ left: i * 100, right: i * 100 + 100, top: 0 }),
  }));
  const gridListeners = {};
  const docListeners = {};
  const fakeGrid = {
    addEventListener: (t, fn) => { gridListeners[t] = fn; },
    querySelectorAll: sel => (sel === '.ca' ? cas : []),
    innerHTML: '',
  };
  globalThis.document = {
    getElementById: id => (id === 'grid' ? fakeGrid : null),
    addEventListener: (t, fn) => { docListeners[t] = fn; },
    removeEventListener: () => {},
    querySelector: () => null,
    dispatchEvent: () => {},
  };
  try {
    store.locked = false;
    store.events = [];
    plan.data = { activities: [{ id: 'geography', status: 'active', onGrid: true, type: 'paced', cls: 'g',
      slots: [{ day: 2, start: 11, end: 12 }], chain: [] }], overrides: [], log: [],
      periods: [], parentCycle: { anchorMonday: '2026-08-17', dutyStart: '2026-08-11', confirmed: true } };
    initGrid();
    const evtEl = { dataset: { slot: 'geography:0' },
      closest: sel => (sel === '.evt' ? evtEl : null),
      getBoundingClientRect: () => ({ top: 0 }),
      classList: { add() {} } };

    // Drag away, then back to the EXACT original {day:2,start:11,end:12}: a
    // real move (crosses the 3px threshold) that nets out to a no-op.
    gridListeners.pointerdown({ button: 0, target: evtEl, clientX: 250, clientY: 0, preventDefault() {} });
    docListeners.pointermove({ clientX: 550, clientY: 264, preventDefault() {} });   // day 5, start 13
    docListeners.pointermove({ clientX: 250, clientY: 132, preventDefault() {} });   // back to day 2, start 11
    docListeners.pointerup();
    assert.deepEqual(plan.data.activities[0].slots[0], { day: 2, start: 11, end: 12 });
    assert.equal(writes, 0, 'landing back on the original slot must never POST');

    // Contrast: a genuine move DOES persist (guards against a fix that just
    // disables the whole commit path).
    gridListeners.pointerdown({ button: 0, target: evtEl, clientX: 250, clientY: 0, preventDefault() {} });
    docListeners.pointermove({ clientX: 550, clientY: 264, preventDefault() {} });   // day 5, start 13
    docListeners.pointerup();
    assert.deepEqual(plan.data.activities[0].slots[0], { day: 5, start: 13, end: 14 });
    assert.equal(writes, 1, 'a genuine move still commits exactly once');
  } finally {
    globalThis.document = savedDoc;
    globalThis.matchMedia = savedMM;
    globalThis.localStorage = savedLS;
  }
});
