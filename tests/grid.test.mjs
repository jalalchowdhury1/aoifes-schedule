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

const { blockRef, slotHTML } = await import('../js/grid.js');

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
